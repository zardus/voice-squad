// @ts-check
/**
 * TTS visibility and background playback tests.
 *
 * Verifies that audio is not dropped when the page is hidden (mobile screen
 * dim, notification center, tab switch) and that the visibilitychange handler
 * does not destroy in-progress playback.
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

test.describe("TTS visibility handling", () => {
  test("audio received while page is hidden is queued, not dropped", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
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

    // Simulate hidden page, send audio, then make visible again.
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });

      // Simulate document becoming hidden
      Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));

      // Send speak_text + audio while hidden
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Background message" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    // Audio should be queued (enqueueTtsPlayback no longer drops hidden-page audio).
    const queuedOrPlayed = await page.evaluate(() => {
      return ttsPlaybackQueue.length + window.__playCalls.length;
    });
    expect(queuedOrPlayed).toBeGreaterThanOrEqual(1);

    // Make page visible again — should NOT clear the queue.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Audio should play after becoming visible.
    await expect
      .poll(() => page.evaluate(() => window.__playCalls.length), { timeout: 3000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("visibilitychange does not stop currently playing audio", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      window.__playCalls = [];
      window.__pauseCalls = 0;
      window.__lastPlayedEl = null;
      const origPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function pause() {
        window.__pauseCalls++;
        return origPause.call(this);
      };
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

    // Start playing audio
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Playing" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
    expect(await page.evaluate(() => ttsPlaybackPlaying)).toBe(true);

    // Simulate page going hidden then visible
    const pausesBefore = await page.evaluate(() => window.__pauseCalls);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Playback should still be in progress — no pause called.
    const pausesAfter = await page.evaluate(() => window.__pauseCalls);
    expect(pausesAfter).toBe(pausesBefore);
    expect(await page.evaluate(() => ttsPlaybackPlaying)).toBe(true);
  });

  test("nativeApp=1 skips PWA audio but stores data for replay", async ({ page }) => {
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

    // Load with nativeApp=1 query parameter
    await page.goto(pageUrl("test-token") + "&nativeApp=1");
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "iOS message" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    await page.waitForTimeout(200);

    // PWA should NOT play audio (native app handles it)
    expect(await page.evaluate(() => window.__playCalls.length)).toBe(0);

    // But audio data should be stored for potential replay
    const hasData = await page.evaluate(() => !!lastTtsAudioData);
    expect(hasData).toBe(true);
  });
});
