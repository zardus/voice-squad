// @ts-check
/**
 * TTS end-to-end tests.
 *
 * Exercises the full TTS pipeline from speak_text + binary audio delivery
 * through to Audio element playback.  Uses a stubbed WebSocket (no real
 * server connection) so the tests run deterministically without API keys.
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/** Generate a minimal valid WAV ArrayBuffer (silence) — as eval-able source. */
function generateSilenceWavSource() {
  return `(() => {
    const sampleRate = 8000;
    const numSamples = sampleRate;
    const dataSize = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i); };
    w(0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    w(8, "WAVE");
    w(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    w(36, "data");
    dv.setUint32(40, dataSize, true);
    return buf;
  })()`;
}

test.describe("TTS end-to-end pipeline", () => {

  // ── Core: speak_text + binary audio triggers playback ──────────

  test("speak_text followed by binary audio triggers Audio.play()", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      window.__playErrors = [];
      window.__lastPlayedEl = null;
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push({ src: this.src, time: Date.now() });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Hello from captain" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
  });

  // ── Auto-read ON by default ────────────────────────────────────

  test("auto-read defaults to ON (speak plays without explicit toggle)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("autoread");
      window.__playCalls = [];
      window.__lastPlayedEl = null;
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push({ src: this.src, time: Date.now() });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    const checked = await page.evaluate(() => {
      const cb = document.getElementById("autoread-cb");
      return cb ? cb.checked : null;
    });
    expect(checked).toBe(true);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Default autoplay test" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
  });

  // ── Auto-read OFF suppresses autoplay ──────────────────────────

  test("auto-read OFF suppresses autoplay but replay still works", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "false");
      window.__playCalls = [];
      window.__playErrors = [];
      window.__lastPlayedEl = null;
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push({ src: this.src, time: Date.now() });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Silent" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__playCalls.length)).toBe(0);

    const hasData = await page.evaluate(() => !!lastTtsAudioData);
    expect(hasData).toBe(true);

    const replayDisabled = await page.evaluate(() => {
      const btn = document.getElementById("voice-replay-btn");
      return btn ? btn.disabled : true;
    });
    expect(replayDisabled).toBe(false);
  });

  // ── speak_text text is shown in voice summary ─────────────────

  test("speak_text updates voice summary display", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      HTMLMediaElement.prototype.play = function play() {
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Status update: all tasks complete" }) });
    });

    await expect(page.locator("#summary")).toHaveText("Status update: all tasks complete");
  });

  // ── Multiple speak messages queue correctly (FIFO) ─────────────

  test("multiple speak messages play in FIFO order", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");

      window.__urlSeq = new Map();
      window.__urlSeqCounter = 0;
      const origCreate = URL.createObjectURL.bind(URL);
      const origRevoke = URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null;
      URL.createObjectURL = (blob) => {
        const url = origCreate(blob);
        window.__urlSeq.set(url, ++window.__urlSeqCounter);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        try { if (origRevoke) origRevoke(url); } catch {}
        try { window.__urlSeq.delete(url); } catch {}
      };

      window.__playCalls = [];
      window.__lastPlayedEl = null;
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push(window.__urlSeq.get(this.src) || null);
        return Promise.resolve();
      };

      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "First" }) });
      ws.onmessage({ data: eval(wavSrc) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Second" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);

    await page.evaluate(() => {
      window.__lastPlayedEl.dispatchEvent(new Event("ended"));
    });
    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(2);
    expect(await page.evaluate(() => window.__playCalls)).toEqual([1, 2]);
  });

  // ── Autoplay blocked → queued for retry after gesture ──────────

  test("autoplay blocked clips are retried after user gesture unlocks audio", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      window.__lastPlayedEl = null;
      window.__playBehaviour = "reject-autoplay";
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        if (window.__playBehaviour === "reject-autoplay") {
          return Promise.reject(new DOMException("user interaction required", "NotAllowedError"));
        }
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Blocked" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__playCalls.length)).toBe(0);
    const queueLen = await page.evaluate(() => ttsPlaybackQueue.length);
    expect(queueLen).toBe(1);

    await page.evaluate(() => {
      window.__playBehaviour = "resolve";
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      drainTtsPlaybackQueueSoon();
    });

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
  });

  // ── Empty audio data is handled gracefully ─────────────────────

  test("empty binary frame does not crash or play", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      window.__playErrors = [];
      HTMLMediaElement.prototype.play = function play() {
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Empty" }) });
      ws.onmessage({ data: new ArrayBuffer(0) });
    });

    await page.waitForTimeout(200);
    const errors = await page.evaluate(() => window.__playErrors ? window.__playErrors.length : 0);
    expect(errors).toBe(0);
  });

  // ── WebSocket binary as Blob (fallback path) ──────────────────

  test("Blob binary frames are handled correctly", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      HTMLMediaElement.prototype.play = function play() {
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Blob test" }) });
      const buf = eval(wavSrc);
      ws.onmessage({ data: new Blob([buf], { type: "audio/wav" }) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
  });

  // ── Queue stuck: ttsPlaybackPlaying doesn't get stuck ──────────

  test("ttsPlaybackPlaying resets on audio error event", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      window.__lastPlayedEl = null;
      HTMLMediaElement.prototype.play = function play() {
        window.__lastPlayedEl = this;
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Clip 1" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
    expect(await page.evaluate(() => ttsPlaybackPlaying)).toBe(true);

    await page.evaluate(() => {
      window.__lastPlayedEl.dispatchEvent(new Event("error"));
    });

    expect(await page.evaluate(() => ttsPlaybackPlaying)).toBe(false);
  });

  // ── speak_text/binary pairing via pendingTtsTexts ──────────────

  test("speak_text and binary audio are paired correctly via pendingTtsTexts", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      HTMLMediaElement.prototype.play = function play() {
        window.__playCalls.push({ src: this.src });
        return Promise.resolve();
      };
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0; this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Message A" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Message B" }) });
    });

    const pending = await page.evaluate(() => pendingTtsTexts.length);
    expect(pending).toBe(2);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    const remainingAfterFirst = await page.evaluate(() => pendingTtsTexts.length);
    expect(remainingAfterFirst).toBe(1);
  });
});
