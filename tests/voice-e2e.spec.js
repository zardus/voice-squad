// @ts-check
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const VOICE_DIR = path.join(__dirname, "..", "src", "voice");
const PORT = 3456; // Test port to avoid conflicts
const TOKEN = "test-token-123";

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

/** Wait for the server to be reachable */
async function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}?token=${TOKEN}`, (res) => {
          res.resume();
          resolve(res);
        });
        req.on("error", reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server not reachable on port ${port} after ${timeoutMs}ms`);
}

let serverProc;

test.beforeAll(async () => {
  // Start voice server with mock-friendly env
  serverProc = spawn("node", ["server.js"], {
    cwd: VOICE_DIR,
    env: {
      ...process.env,
      VOICE_PORT: String(PORT),
      VOICE_TOKEN: TOKEN,
      SQUAD_CAPTAIN: "claude",
      // Real API keys from env (tests hit real APIs)
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer(PORT);
});

test.afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await new Promise((r) => serverProc.on("exit", r));
  }
});

test("page loads and connects via WebSocket", async ({ page }) => {
  await page.goto(`http://localhost:${PORT}?token=${TOKEN}`);

  // Status should show "claude" (connected)
  await expect(page.locator("#status")).toHaveText("claude", { timeout: 5000 });
  await expect(page.locator("#status")).toHaveClass(/connected/);

  // Core UI elements exist
  await expect(page.locator("#mic-btn")).toBeVisible();
  await expect(page.locator("#text-input")).toBeVisible();
  await expect(page.locator("#send-btn")).toBeVisible();
});

test("rejects WebSocket without token", async ({ page }) => {
  // Load the page with correct token first
  await page.goto(`http://localhost:${PORT}?token=${TOKEN}`);
  await expect(page.locator("#status")).toHaveText("claude", { timeout: 5000 });

  // Try to connect WebSocket without token — should fail
  const result = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${location.port}`);
      ws.onopen = () => resolve("connected");
      ws.onclose = () => resolve("rejected");
      ws.onerror = () => resolve("rejected");
      setTimeout(() => resolve("timeout"), 3000);
    });
  });
  expect(result).toBe("rejected");
});

test("send WAV audio via WebSocket and get transcription", async ({ page }) => {
  test.skip(!process.env.OPENAI_API_KEY, "OPENAI_API_KEY required");

  await page.goto(`http://localhost:${PORT}?token=${TOKEN}`);
  await expect(page.locator("#status")).toHaveText("claude", { timeout: 5000 });

  // Generate WAV and send via WebSocket protocol
  const wav = generateWav(2, 16000, 440);
  const wavBase64 = wav.toString("base64");

  const transcription = await page.evaluate(async (wavB64) => {
    return new Promise((resolve, reject) => {
      const token = new URLSearchParams(location.search).get("token");
      const ws = new WebSocket(`ws://localhost:${location.port}?token=${token}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        // Send audio_start
        ws.send(JSON.stringify({ type: "audio_start", mimeType: "audio/wav" }));

        // Send binary audio
        const raw = atob(wavB64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        ws.send(arr.buffer);

        // Send audio_end
        ws.send(JSON.stringify({ type: "audio_end" }));
      };

      const timeout = setTimeout(() => reject(new Error("timeout waiting for transcription")), 30000);

      ws.onmessage = (evt) => {
        if (typeof evt.data === "string") {
          const msg = JSON.parse(evt.data);
          if (msg.type === "transcription") {
            clearTimeout(timeout);
            resolve(msg.text);
          } else if (msg.type === "error") {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      };
    });
  }, wavBase64);

  console.log(`Transcription: "${transcription}"`);
  expect(transcription).toBeTruthy();
});

test("send MediaRecorder WebM audio via WebSocket and get transcription", async ({ page }) => {
  test.skip(!process.env.OPENAI_API_KEY, "OPENAI_API_KEY required");

  await page.goto(`http://localhost:${PORT}?token=${TOKEN}`);
  await expect(page.locator("#status")).toHaveText("claude", { timeout: 5000 });

  // Use the browser's OscillatorNode + MediaRecorder to produce real WebM audio,
  // exactly as the app does on a phone.
  const result = await page.evaluate(async () => {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 30000);

      try {
        // Create audio via OscillatorNode -> MediaStreamDestination
        const ctx = new AudioContext({ sampleRate: 16000 });
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();

        // Pick mime type exactly like the app does
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

          // Now send through WebSocket exactly like app.js does
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
                resolve({ ok: true, text: msg.text, mimeType, chunkCount: chunks.length, totalSize: chunks.reduce((s, c) => s + c.size, 0) });
              } else if (msg.type === "error") {
                clearTimeout(timeout);
                resolve({ ok: false, error: msg.message, mimeType, chunkCount: chunks.length, totalSize: chunks.reduce((s, c) => s + c.size, 0) });
              }
            }
          };
        };

        // Record for 2 seconds with 250ms timeslice (matching app.js)
        recorder.start(250);
        setTimeout(() => recorder.stop(), 2000);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });

  console.log("MediaRecorder result:", JSON.stringify(result, null, 2));
  // WebM upload succeeded (no 400), transcription may be empty for a tone
  expect(result.ok).toBe(true);
});

test("log all supported MediaRecorder mime types", async ({ page }) => {
  await page.goto(`http://localhost:${PORT}?token=${TOKEN}`);

  const formats = await page.evaluate(() => {
    const types = [
      "audio/webm", "audio/webm;codecs=opus", "audio/webm;codecs=pcm",
      "audio/ogg", "audio/ogg;codecs=opus",
      "audio/mp4", "audio/mp4;codecs=mp4a.40.2",
      "audio/mpeg", "audio/wav",
      "video/webm", "video/webm;codecs=vp8,opus",
    ];
    return types.map((t) => ({ type: t, supported: MediaRecorder.isTypeSupported(t) }));
  });

  console.log("Supported MediaRecorder formats:");
  for (const f of formats) {
    console.log(`  ${f.supported ? "YES" : " no"} ${f.type}`);
  }
});
