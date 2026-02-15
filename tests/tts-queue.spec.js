// @ts-check
/**
 * TTS playback queue tests.
 *
 * We stub WebSocket + media playback so we can deterministically assert that:
 * - multiple incoming binary frames do not interrupt/overlap playback
 * - playback is FIFO and advances on ended/error
 * - the queue is capped to avoid unbounded growth
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

test.describe("TTS playback queue", () => {
  test("plays sequentially (FIFO) without interrupting current clip", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");

      // Record a stable sequence number for each created object URL so we can assert FIFO ordering
      // without relying on the blob URL string itself.
      window.__urlSeq = new Map();
      window.__urlSeqCounter = 0;
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      const origRevokeObjectURL = URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null;
      URL.createObjectURL = (blob) => {
        const url = origCreateObjectURL(blob);
        window.__urlSeq.set(url, ++window.__urlSeqCounter);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        try {
          if (origRevokeObjectURL) origRevokeObjectURL(url);
        } catch {}
        try { window.__urlSeq.delete(url); } catch {}
      };

      window.__playCalls = [];
      window.__overlap = false;
      window.__lastPlayedEl = null;

      HTMLMediaElement.prototype.play = function play() {
        // Only track the app's TTS element; other Audio instances shouldn't call play() in these tests.
        if (!this.__testHooked) {
          this.__testHooked = true;
          this.__testPlaying = false;
          this.addEventListener("ended", () => { this.__testPlaying = false; });
          this.addEventListener("error", () => { this.__testPlaying = false; });
        }
        if (this.__testPlaying) window.__overlap = true;
        this.__testPlaying = true;
        window.__lastPlayedEl = this;
        window.__playCalls.push(window.__urlSeq.get(this.src) || null);
        return Promise.resolve();
      };

      // Stub WebSocket used by the app so tests can inject messages.
      class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose();
        }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Two audio frames arrive back-to-back: only the first should start playing immediately.
    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });

      const generateSilenceWav = (durationSec = 1, sampleRate = 8000) => {
        const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
        const dataSize = numSamples * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const u8 = new Uint8Array(buf);
        const dv = new DataView(buf);
        const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) u8[offset + i] = s.charCodeAt(i); };
        writeStr(0, "RIFF");
        dv.setUint32(4, 36 + dataSize, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        dv.setUint32(16, 16, true); // PCM header size
        dv.setUint16(20, 1, true); // PCM
        dv.setUint16(22, 1, true); // mono
        dv.setUint32(24, sampleRate, true);
        dv.setUint32(28, sampleRate * 2, true); // byte rate
        dv.setUint16(32, 2, true); // block align
        dv.setUint16(34, 16, true); // bits per sample
        writeStr(36, "data");
        dv.setUint32(40, dataSize, true);
        // Samples are already zero (silence)
        return buf;
      };

      ws.onmessage({ data: generateSilenceWav(1) });
      ws.onmessage({ data: generateSilenceWav(1) });
    });

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
    expect(await page.evaluate(() => window.__overlap)).toBe(false);

    // When the first clip ends, the second should start automatically.
    await page.evaluate(() => {
      window.__lastPlayedEl.dispatchEvent(new Event("ended"));
    });
    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(2);
    expect(await page.evaluate(() => window.__playCalls)).toEqual([1, 2]);
  });

  test("caps the queue (keeps last 5, drops oldest)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");

      window.__urlSeq = new Map();
      window.__urlSeqCounter = 0;
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      const origRevokeObjectURL = URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null;
      URL.createObjectURL = (blob) => {
        const url = origCreateObjectURL(blob);
        window.__urlSeq.set(url, ++window.__urlSeqCounter);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        try {
          if (origRevokeObjectURL) origRevokeObjectURL(url);
        } catch {}
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
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose();
        }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Enqueue 10 audio frames quickly.
    // With a cap of 5 total pending clips (current + queued), we should eventually play 5 total.
    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });

      const generateSilenceWav = (durationSec = 1, sampleRate = 8000) => {
        const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
        const dataSize = numSamples * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const u8 = new Uint8Array(buf);
        const dv = new DataView(buf);
        const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) u8[offset + i] = s.charCodeAt(i); };
        writeStr(0, "RIFF");
        dv.setUint32(4, 36 + dataSize, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true);
        dv.setUint32(24, sampleRate, true);
        dv.setUint32(28, sampleRate * 2, true);
        dv.setUint16(32, 2, true);
        dv.setUint16(34, 16, true);
        writeStr(36, "data");
        dv.setUint32(40, dataSize, true);
        return buf;
      };

      for (let i = 0; i < 10; i++) {
        ws.onmessage({ data: generateSilenceWav(1) });
      }
    });

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);

    // Drain by firing ended repeatedly; each ended should trigger the next queued clip.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 15; i++) {
        if (!window.__lastPlayedEl) break;
        window.__lastPlayedEl.dispatchEvent(new Event("ended"));
        await sleep(0);
      }
    });

    await expect.poll(() => page.evaluate(() => window.__playCalls.length), { timeout: 5000 }).toBe(5);
  });
});
