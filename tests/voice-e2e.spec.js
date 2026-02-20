// @ts-check
/**
 * Voice E2E tests — send real audio through the WebSocket pipeline and verify
 * STT transcription via OpenAI Whisper.
 *
 * These tests require a real OPENAI_API_KEY and are opt-in:
 *   TEST_CAPTAIN=1 ./test.sh voice-e2e.spec.js
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN, pageUrl } = require("./helpers/config");
const https = require("https");
const { execSync } = require("child_process");
const fs = require("fs");
const { captainExec } = require("./helpers/tmux");

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

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call OpenAI Whisper API directly for STT verification.
 * Bypasses the voice server pipeline to avoid feeding the transcription
 * back to the captain (which would create a feedback loop).
 */
function whisperTranscribe(audioBuffer) {
  const boundary = "----TestBoundary" + Date.now();

  let ext = "mp3";
  let mime = "audio/mpeg";
  if (audioBuffer[0] === 0x1a && audioBuffer[1] === 0x45) {
    ext = "webm"; mime = "audio/webm";
  } else if (audioBuffer.slice(0, 4).toString() === "OggS") {
    ext = "ogg"; mime = "audio/ogg";
  } else if (audioBuffer.slice(0, 4).toString() === "RIFF") {
    ext = "wav"; mime = "audio/wav";
  }

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`
    ),
    audioBuffer,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n--${boundary}--\r\n`
    ),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`Whisper API ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text).text);
          } catch (e) {
            reject(new Error(`Failed to parse Whisper response: ${text}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () =>
      req.destroy(new Error("Whisper request timed out"))
    );
    req.end(body);
  });
}

/**
 * Ensure the Claude captain is running in tmux captain:0.
 * Configures API keys, handles first-run dialogs, waits for the prompt.
 */
async function ensureCaptainRunning() {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-ant-test")) {
    try {
      apiKey = execSync("bash -c '. /home/ubuntu/env && echo $ANTHROPIC_API_KEY'", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {}
  }
  if (!apiKey || apiKey.startsWith("sk-ant-test")) {
    throw new Error("Real ANTHROPIC_API_KEY required for captain voice E2E");
  }

  // Pre-configure Claude Code (skip onboarding)
  fs.mkdirSync("/home/ubuntu/.claude", { recursive: true });
  fs.writeFileSync(
    "/home/ubuntu/.claude.json",
    JSON.stringify({ hasCompletedOnboarding: true })
  );

  const helperPath = "/home/ubuntu/.claude/api-key-helper.sh";
  fs.writeFileSync(helperPath, `#!/bin/sh\necho '${apiKey}'\n`);
  execSync(`chmod +x ${helperPath}`, { timeout: 5000 });
  fs.writeFileSync(
    "/home/ubuntu/.claude/settings.json",
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: apiKey },
      apiKeyHelper: helperPath,
    })
  );

  // Export API key to bashrc and tmux env
  try {
    const bashrc = fs.readFileSync("/home/ubuntu/.bashrc", "utf8");
    if (!bashrc.includes("ANTHROPIC_API_KEY")) {
      fs.appendFileSync(
        "/home/ubuntu/.bashrc",
        `\nexport ANTHROPIC_API_KEY='${apiKey}'\n`
      );
    }
  } catch {
    fs.writeFileSync(
      "/home/ubuntu/.bashrc",
      `export ANTHROPIC_API_KEY='${apiKey}'\n`
    );
  }
  try {
    captainExec(`set-environment -t captain ANTHROPIC_API_KEY '${apiKey}'`);
  } catch {}

  // Kill anything currently running in captain:0
  for (let i = 0; i < 3; i++) {
    try {
      captainExec("send-keys -t captain:0 C-c");
    } catch {}
  }
  await sleep(1000);

  // Start Claude
  console.log("[voice-e2e] Starting Claude captain...");
  captainExec(
    'send-keys -t captain:0 "cd /opt/squad/captain && unset TMUX && source ~/.bashrc && claude" Enter',
    { timeout: 10000 }
  );

  // Wait for Claude to be ready (handle setup dialogs)
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    try {
      const shellPid = captainExec(
        "list-panes -t captain:0 -F '#{pane_pid}'"
      ).trim();
      const childPid = execSync(
        `ps -o pid= --ppid ${shellPid} 2>/dev/null | head -1`,
        { encoding: "utf8", timeout: 5000 }
      ).trim();

      if (!childPid) {
        const raw = captainExec("capture-pane -t captain:0 -p -S -50");
        if (stripAnsi(raw).includes("Yes, I accept")) {
          captainExec("send-keys -t captain:0 Enter");
          await sleep(1000);
          captainExec(
            'send-keys -t captain:0 "unset TMUX && claude" Enter',
            { timeout: 10000 }
          );
        }
        continue;
      }

      const raw = captainExec("capture-pane -t captain:0 -p");
      const cleaned = stripAnsi(raw);

      if (
        cleaned.includes("Choose the text style") ||
        cleaned.includes("Let's get started")
      ) {
        captainExec("send-keys -t captain:0 Enter");
        await sleep(1000);
        continue;
      }
      if (
        cleaned.includes("Yes, I accept") &&
        cleaned.includes("Enter to confirm")
      ) {
        captainExec("send-keys -t captain:0 2");
        await sleep(500);
        captainExec("send-keys -t captain:0 Enter");
        await sleep(3000);
        continue;
      }
      if (cleaned.includes("Enter to confirm")) {
        captainExec("send-keys -t captain:0 Enter");
        await sleep(2000);
        continue;
      }

      if (
        cleaned.includes("/home/ubuntu") ||
        cleaned.includes("What can I help") ||
        cleaned.includes("Type your") ||
        cleaned.includes("help you")
      ) {
        if (!cleaned.includes("Enter to confirm")) {
          ready = true;
          console.log("[voice-e2e] Claude captain ready.");
          break;
        }
      }

      if (i > 0 && i % 15 === 0) {
        const lines = cleaned.split("\n").filter((l) => l.trim());
        const tail = lines.slice(-2).map((l) => l.slice(-80));
        console.log(
          `[voice-e2e] Waiting for captain (${i * 2}s)... ${JSON.stringify(tail)}`
        );
      }
    } catch {}
  }

  if (!ready) throw new Error("Captain failed to start within timeout");
  await sleep(3000);
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

  test("Voice round trip: TTS command → captain → speak response → STT verify", async ({ page }) => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run voice E2E tests");
    test.setTimeout(10 * 60 * 1000); // 10 minutes — captain startup + processing

    // ── Phase 0: Ensure captain is running ──
    await ensureCaptainRunning();

    // ── Phase 1: Synthesize command audio via TTS ──
    const TARGET_PHRASE = "purple elephants dance at midnight under golden stars";
    const COMMAND =
      `Use the speak command to say exactly this phrase and nothing else: ${TARGET_PHRASE}`;

    console.log("[voice-e2e] Synthesizing command audio via TTS...");
    const ttsResp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TOKEN,
        text: COMMAND,
        playbackOnly: true,
        format: "mp3",
      }),
    });
    expect(ttsResp.status).toBe(200);

    const commandAudio = Buffer.from(await ttsResp.arrayBuffer());
    console.log(`[voice-e2e] Command TTS: ${commandAudio.length} bytes of mp3`);
    expect(commandAudio.length).toBeGreaterThan(1000);

    // ── Phase 2: Send command through the actual voice pipeline via Playwright ──
    // The audio goes: browser WS → voice server STT → tmux send-keys → captain
    // Captain responds via `speak "..."` -> internal speak socket -> TTS -> WS broadcast
    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 10000 });

    const commandB64 = commandAudio.toString("base64");

    console.log("[voice-e2e] Sending command audio through WebSocket pipeline...");
    const result = await page.evaluate(
      async ({ audioB64, keywords }) => {
        return new Promise((resolve, reject) => {
          let commandTranscription = "";
          let gotTranscription = false;
          let pendingSpeakText = null;
          const allSpeakTexts = [];
          let found = false;

          const TIMEOUT_MS = 5 * 60 * 1000;
          const timeout = setTimeout(() => {
            reject(
              new Error(
                `timeout (${TIMEOUT_MS / 1000}s): captain never spoke back with target phrase. ` +
                  `Transcription: "${commandTranscription}", speak_texts: ${JSON.stringify(allSpeakTexts)}`
              )
            );
          }, TIMEOUT_MS);

          const token = new URLSearchParams(location.search).get("token");
          const ws = new WebSocket(
            `ws://localhost:${location.port}?token=${token}&tts=mp3`
          );
          ws.binaryType = "arraybuffer";

          ws.onopen = () => {
            // Send command audio through the STT pipeline
            ws.send(
              JSON.stringify({ type: "audio_start", mimeType: "audio/mpeg" })
            );

            const raw = atob(audioB64);
            const arr = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            ws.send(arr.buffer);

            ws.send(JSON.stringify({ type: "audio_end" }));
          };

          ws.onmessage = (evt) => {
            if (found) return;

            // Binary frame = TTS audio from captain's speak command
            if (evt.data instanceof ArrayBuffer) {
              if (pendingSpeakText && gotTranscription) {
                const lower = pendingSpeakText.toLowerCase();
                const matches = keywords.every((k) => lower.includes(k));
                if (matches) {
                  // This is the captain's response with our target phrase
                  found = true;
                  const bytes = new Uint8Array(evt.data);
                  // Convert ArrayBuffer to base64 in chunks (avoid stack overflow)
                  let binary = "";
                  const CHUNK = 8192;
                  for (let i = 0; i < bytes.length; i += CHUNK) {
                    const slice = bytes.subarray(
                      i,
                      Math.min(i + CHUNK, bytes.length)
                    );
                    binary += String.fromCharCode.apply(null, slice);
                  }
                  clearTimeout(timeout);
                  ws.close();
                  resolve({
                    commandTranscription,
                    captainSpeakText: pendingSpeakText,
                    captainAudioB64: btoa(binary),
                    allSpeakTexts,
                  });
                }
              }
              pendingSpeakText = null;
              return;
            }

            let msg;
            try {
              msg = JSON.parse(evt.data);
            } catch {
              return;
            }

            if (msg.type === "transcription" && !gotTranscription) {
              commandTranscription = msg.text;
              gotTranscription = true;
            } else if (msg.type === "speak_text") {
              pendingSpeakText = msg.text || "";
              allSpeakTexts.push(pendingSpeakText);
            } else if (msg.type === "stt_error" && !gotTranscription) {
              clearTimeout(timeout);
              reject(
                new Error("STT failed on command audio: " + msg.message)
              );
            }
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        });
      },
      { audioB64: commandB64, keywords: ["purple", "elephant"] }
    );

    console.log(
      `[voice-e2e] Command transcription: "${result.commandTranscription}"`
    );
    console.log(`[voice-e2e] Captain spoke: "${result.captainSpeakText}"`);
    console.log(
      `[voice-e2e] All speak texts: ${JSON.stringify(result.allSpeakTexts)}`
    );

    // ── Phase 3: Verify captain's speak_text contains the target phrase ──
    const speakLower = result.captainSpeakText.toLowerCase();
    expect(speakLower).toContain("purple");
    expect(speakLower).toContain("elephant");

    // ── Phase 4: STT the captain's response audio to verify it was actually spoken ──
    // Uses Whisper API directly (not through the voice server pipeline, which
    // would send the transcription back to the captain and create a loop).
    console.log("[voice-e2e] Running STT on captain's response audio...");
    const responseAudio = Buffer.from(result.captainAudioB64, "base64");
    console.log(`[voice-e2e] Response audio: ${responseAudio.length} bytes`);
    expect(responseAudio.length).toBeGreaterThan(1000);

    const sttText = await whisperTranscribe(responseAudio);
    console.log(`[voice-e2e] Response STT: "${sttText}"`);

    const sttLower = sttText.toLowerCase();
    expect(sttLower).toContain("purple");
    expect(sttLower).toContain("elephant");
    expect(sttLower).toContain("midnight");

    console.log("[voice-e2e] Full voice round trip verified!");

    // Cleanup: stop captain
    try {
      captainExec("send-keys -t captain:0 C-c");
      captainExec("send-keys -t captain:0 C-c");
    } catch {}
  });
});
