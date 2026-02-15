// @ts-check
/**
 * Voice E2E tests — send real audio through the WebSocket pipeline and verify
 * STT transcription via OpenAI Whisper.
 *
 * These tests require a real OPENAI_API_KEY and are opt-in:
 *   TEST_CAPTAIN=1 ./test.sh voice-e2e.spec.js
 */
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl } = require("./helpers/config");

const CAPTAIN = process.env.TEST_CAPTAIN === "1";

/**
 * Generate a valid WAV buffer with a sine wave tone.
 */
function generateWav(durationSec = 2, sampleRate = 16000, freq = 440) {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin(2 * Math.PI * freq * i / sampleRate) * 0.5 * 32767;
    buf.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  return buf;
}

test.describe("Voice E2E", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("STT via WAV: send audio and get Whisper transcription", async ({ page }) => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run voice E2E tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

    // Generate WAV and send via WebSocket protocol
    const wav = generateWav(2, 16000, 440);
    const wavBase64 = wav.toString("base64");

    const result = await page.evaluate(async (wavB64) => {
      return new Promise((resolve, reject) => {
        const token = new URLSearchParams(location.search).get("token");
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${token}`);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "audio_start", mimeType: "audio/wav" }));

          const raw = atob(wavB64);
          const arr = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          ws.send(arr.buffer);

          ws.send(JSON.stringify({ type: "audio_end" }));
        };

        const timeout = setTimeout(() => reject(new Error("timeout waiting for transcription")), 30000);

        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const msg = JSON.parse(evt.data);
            if (msg.type === "transcription") {
              clearTimeout(timeout);
              resolve({ type: "transcription", text: msg.text });
            } else if (msg.type === "stt_error") {
              // Whisper processed the audio but found no speech (expected for a sine wave)
              clearTimeout(timeout);
              resolve({ type: "stt_error", message: msg.message });
            } else if (msg.type === "error") {
              clearTimeout(timeout);
              reject(new Error(msg.message));
            }
          }
        };
      });
    }, wavBase64);

    console.log(`[voice-e2e] WAV result: ${JSON.stringify(result)}`);
    // Pipeline worked end-to-end: either Whisper transcribed something or reported no speech
    expect(["transcription", "stt_error"]).toContain(result.type);
  });

  test("STT via WebM: MediaRecorder audio gets Whisper transcription", async ({ page }) => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run voice E2E tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

    // Use the browser's OscillatorNode + MediaRecorder to produce real WebM audio,
    // exactly as the app does on a phone.
    const result = await page.evaluate(async () => {
      return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 30000);

        try {
          const ctx = new AudioContext({ sampleRate: 16000 });
          const osc = ctx.createOscillator();
          osc.frequency.value = 440;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(dest);
          osc.start();

          const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm")
              ? "audio/webm"
              : "audio/mp4";

          const recorder = new MediaRecorder(dest.stream, { mimeType });
          const chunks = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          recorder.onstop = async () => {
            osc.stop();
            ctx.close();

            const token = new URLSearchParams(location.search).get("token");
            const ws = new WebSocket(`ws://localhost:${location.port}?token=${token}`);
            ws.binaryType = "arraybuffer";

            ws.onopen = async () => {
              ws.send(JSON.stringify({ type: "audio_start", mimeType }));
              for (const chunk of chunks) {
                const buf = await chunk.arrayBuffer();
                ws.send(buf);
              }
              ws.send(JSON.stringify({ type: "audio_end" }));
            };

            ws.onmessage = (evt) => {
              if (typeof evt.data === "string") {
                const msg = JSON.parse(evt.data);
                if (msg.type === "transcription") {
                  clearTimeout(timeout);
                  resolve({ ok: true, text: msg.text, mimeType });
                } else if (msg.type === "stt_error") {
                  // Whisper processed audio but found no speech (expected for a tone)
                  clearTimeout(timeout);
                  resolve({ ok: true, text: "", mimeType, noSpeech: true });
                } else if (msg.type === "error") {
                  clearTimeout(timeout);
                  resolve({ ok: false, error: msg.message, mimeType });
                }
              }
            };
          };

          recorder.start(250);
          setTimeout(() => recorder.stop(), 2000);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    console.log(`[voice-e2e] WebM result: ${JSON.stringify(result)}`);
    expect(result.ok).toBe(true);
  });
});
