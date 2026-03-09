// @ts-check
/**
 * STT timeout tests — verify the client recovers from stuck "Uploading 100%"
 * and "Transcribing..." states when the server never responds.
 *
 * These are pure client-side tests using a FakeWebSocket stub (no real server).
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/**
 * Inject stubs before app.js loads:
 *  - FakeWebSocket with controllable message delivery and bufferedAmount
 *  - Fake getUserMedia / MediaRecorder so recording flow completes
 *  - Short STT timeout values for fast tests
 */
function addStubs(page, opts = {}) {
  const responseTimeoutMs = opts.responseTimeoutMs || 500;
  const transcriptionTimeoutMs = opts.transcriptionTimeoutMs || 1000;

  return page.addInitScript(({ responseTimeoutMs, transcriptionTimeoutMs }) => {
    // Shorter timeouts for testing.
    window.__STT_RESPONSE_TIMEOUT_MS = responseTimeoutMs;
    window.__STT_TRANSCRIPTION_TIMEOUT_MS = transcriptionTimeoutMs;

    // --- getUserMedia stub ---
    window.__gumCalls = 0;
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => {
      window.__gumCalls += 1;
      const track = {
        readyState: "live",
        stop() { this.readyState = "ended"; },
        onended: null,
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };

    // --- MediaRecorder stub ---
    window.__mediaRecorderInstance = null;
    window.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor(stream, opts) {
        this.state = "inactive";
        this.mimeType = (opts && opts.mimeType) || "audio/webm";
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
        window.__mediaRecorderInstance = this;
      }
      start() {
        this.state = "recording";
        // Emit a fake audio chunk after a short delay.
        setTimeout(() => {
          if (this.ondataavailable && this.state === "recording") {
            // 2KB of zeros — enough to pass MIN_AUDIO_BYTES check.
            const blob = new Blob([new Uint8Array(2048)], { type: this.mimeType });
            this.ondataavailable({ data: blob });
          }
        }, 50);
      }
      stop() {
        this.state = "inactive";
        if (this.onstop) setTimeout(() => this.onstop(), 0);
      }
    };

    // --- FakeWebSocket ---
    window.__wsSent = [];           // all messages sent by the app
    window.__wsBinarySent = 0;      // total binary bytes sent
    window.__wsInstance = null;

    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.bufferedAmount = 0;
        this.binaryType = "arraybuffer";
        this.onopen = null;
        this.onclose = null;
        this.onmessage = null;
        this.onerror = null;
        window.__wsInstance = this;
        // Simulate connection after microtask.
        setTimeout(() => {
          if (this.onopen) this.onopen();
          // Send initial "connected" message.
          this._deliver({ type: "connected", overseer: "claude", lastSpeakText: null });
          this._deliver({ type: "tts_config", format: "mp3", mime: "audio/mpeg" });
          this._deliver({ type: "voice_history", entries: [] });
        }, 0);
      }
      send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        if (typeof data === "string") {
          window.__wsSent.push(JSON.parse(data));
        } else {
          window.__wsBinarySent += (data.byteLength || data.length || 0);
        }
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        if (this.onclose) this.onclose();
      }
      /** Deliver a server→client message. */
      _deliver(obj) {
        if (this.onmessage) {
          this.onmessage({ data: JSON.stringify(obj) });
        }
      }
    }
    // Copy static constants to prototype for `WebSocket.OPEN` references.
    FakeWebSocket.prototype.CONNECTING = 0;
    FakeWebSocket.prototype.OPEN = 1;
    FakeWebSocket.prototype.CLOSING = 2;
    FakeWebSocket.prototype.CLOSED = 3;

    window.WebSocket = FakeWebSocket;
  }, { responseTimeoutMs, transcriptionTimeoutMs });
}

/**
 * Simulate a full push-to-talk cycle: press → hold → release.
 * Hold time must exceed MIN_RECORDING_MS (300ms) or it's treated as accidental tap.
 * The ensureMicStream() async call takes a few microtasks before recording starts.
 */
async function simulateRecording(page) {
  const micBtn = page.locator("#mic-btn");
  await micBtn.dispatchEvent("mousedown");
  // Wait for ensureMicStream → getUserMedia → startRecording retry → MediaRecorder.start
  // and for the fake chunk to be emitted (50ms). Then hold past MIN_RECORDING_MS (300ms).
  await page.waitForTimeout(500);
  await micBtn.dispatchEvent("mouseup");
  // Wait for onstop handler to run the async upload flow.
  await page.waitForTimeout(300);
}

test.describe("STT timeout recovery", () => {
  test("shows error when server never acknowledges upload (stuck at 100%)", async ({ page }) => {
    await addStubs(page, { responseTimeoutMs: 500, transcriptionTimeoutMs: 2000 });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__wsInstance);

    await simulateRecording(page);

    // After recording, the app should show uploading indicator.
    // Since FakeWebSocket has bufferedAmount=0, it jumps to 100% immediately.
    // The app then waits for the server "transcribing" message, which never comes.

    // Verify that audio_end was sent.
    await expect.poll(async () =>
      page.evaluate(() => window.__wsSent.some((m) => m.type === "audio_end"))
    ).toBe(true);

    // Wait for the response timeout (500ms + margin).
    await page.waitForTimeout(800);

    // The transcription element should show the timeout error.
    const text = await page.locator("#transcription").textContent();
    expect(text).toContain("timed out");
  });

  test("shows error when transcription phase hangs after server ack", async ({ page }) => {
    await addStubs(page, { responseTimeoutMs: 2000, transcriptionTimeoutMs: 500 });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__wsInstance);

    await simulateRecording(page);

    // Verify audio_end was sent.
    await expect.poll(async () =>
      page.evaluate(() => window.__wsSent.some((m) => m.type === "audio_end"))
    ).toBe(true);

    // Server sends "transcribing" but never sends "transcription" or "stt_error".
    await page.evaluate(() => {
      window.__wsInstance._deliver({ type: "transcribing" });
    });

    // Should now show "Transcribing..."
    await expect(page.locator("#transcription")).toHaveText("Transcribing...");

    // Wait for the transcription timeout (500ms + margin).
    await page.waitForTimeout(800);

    // The transcription element should show the timeout error.
    const text = await page.locator("#transcription").textContent();
    expect(text).toContain("timed out");
  });

  test("timeout is cleared when transcription arrives normally", async ({ page }) => {
    await addStubs(page, { responseTimeoutMs: 500, transcriptionTimeoutMs: 500 });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__wsInstance);

    await simulateRecording(page);

    // Verify audio_end was sent.
    await expect.poll(async () =>
      page.evaluate(() => window.__wsSent.some((m) => m.type === "audio_end"))
    ).toBe(true);

    // Server sends normal sequence: transcribing → transcription.
    await page.evaluate(() => {
      window.__wsInstance._deliver({ type: "transcribing" });
    });
    await expect(page.locator("#transcription")).toHaveText("Transcribing...");

    await page.evaluate(() => {
      window.__wsInstance._deliver({ type: "transcription", text: "hello world" });
    });

    // Should show the transcribed text, not an error.
    await expect(page.locator("#transcription")).toHaveText("hello world");

    // Wait past both timeouts — no error should appear.
    await page.waitForTimeout(800);
    await expect(page.locator("#transcription")).toHaveText("hello world");
  });

  test("timeout is cleared when stt_error arrives", async ({ page }) => {
    await addStubs(page, { responseTimeoutMs: 500, transcriptionTimeoutMs: 500 });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__wsInstance);

    await simulateRecording(page);

    await expect.poll(async () =>
      page.evaluate(() => window.__wsSent.some((m) => m.type === "audio_end"))
    ).toBe(true);

    // Server sends error directly (no transcribing phase).
    await page.evaluate(() => {
      window.__wsInstance._deliver({ type: "stt_error", message: "No speech detected" });
    });

    await expect(page.locator("#transcription")).toHaveText("No speech detected");

    // Wait past the timeout — should still show the original error, not timeout.
    await page.waitForTimeout(800);
    await expect(page.locator("#transcription")).toHaveText("No speech detected");
  });

  test("detects dead WebSocket during upload drain", async ({ page }) => {
    await addStubs(page, { responseTimeoutMs: 2000, transcriptionTimeoutMs: 2000 });

    // Override the FakeWebSocket to simulate a large buffered amount that never drains.
    await page.addInitScript(() => {
      const OrigFakeWS = window.WebSocket;
      class SlowDrainWebSocket extends OrigFakeWS {
        constructor(url) {
          super(url);
        }
        send(data) {
          super.send(data);
          if (typeof data === "string") {
            try {
              const msg = JSON.parse(data);
              if (msg.type === "audio_end") {
                // Simulate large buffer that won't drain.
                this.bufferedAmount = 1024 * 1024;
                // Kill the connection mid-drain after 200ms.
                setTimeout(() => {
                  this.readyState = 3; // CLOSED
                }, 200);
              }
            } catch {}
          }
        }
      }
      window.WebSocket = SlowDrainWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__wsInstance);

    await simulateRecording(page);

    // The drain loop should detect the dead socket and show an error.
    await page.waitForTimeout(800);

    const text = await page.locator("#transcription").textContent();
    expect(text).toContain("Connection lost");
  });
});

test.describe("STT server-side audio protocol", () => {
  const { TOKEN, BASE_URL } = require("./helpers/config");
  const WS_URL = BASE_URL.replace(/^http/, "ws");

  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("server sends stt_error for too-short audio", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.binaryType = "arraybuffer";
        let connected = false;

        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const msg = JSON.parse(evt.data);
            if (msg.type === "connected") {
              connected = true;
              // Send audio_start + tiny audio + audio_end.
              ws.send(JSON.stringify({ type: "audio_start", mimeType: "audio/wav" }));
              ws.send(new Uint8Array(100).buffer); // too small
              ws.send(JSON.stringify({ type: "audio_end" }));
            } else if (connected && msg.type === "stt_error") {
              // Wait specifically for stt_error (transcribing may arrive first).
              ws.close();
              resolve(msg);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 10000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(result.type).toBe("stt_error");
  });

  test("server handles WebSocket close during audio gracefully", async ({ page }) => {
    await page.goto(pageUrl());

    // Send audio data then immediately close the connection.
    // The server should not crash with an unhandled rejection.
    const result = await page.evaluate(async (params) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.binaryType = "arraybuffer";

        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const msg = JSON.parse(evt.data);
            if (msg.type === "connected") {
              // Send audio start + some data + audio_end, then close immediately.
              ws.send(JSON.stringify({ type: "audio_start", mimeType: "audio/wav" }));
              ws.send(new Uint8Array(2000).buffer);
              ws.send(JSON.stringify({ type: "audio_end" }));
              // Close immediately — server's handleAudioCommand will try to send
              // to a closed socket.  safeSend should handle this gracefully.
              setTimeout(() => {
                ws.close();
                resolve("closed");
              }, 50);
            }
          }
        };

        ws.onerror = () => resolve("error");
        setTimeout(() => resolve("timeout"), 5000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    // We expect either "closed" (normal) or "timeout" (if the server is slow).
    // The key assertion is that the server didn't crash — verify by making
    // a fresh connection.
    expect(["closed", "timeout"]).toContain(result);

    // Verify server is still alive by connecting again.
    const alive = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const msg = JSON.parse(evt.data);
            if (msg.type === "connected") {
              ws.close();
              resolve(true);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error after audio close test"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(alive).toBe(true);
  });
});
