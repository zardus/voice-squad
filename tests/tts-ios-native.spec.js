// @ts-check
/**
 * iOS native app TTS reproduction tests.
 *
 * The iOS native app loads the PWA with ?nativeApp=1, which causes
 * handleIncomingTtsAudio() to return early — disabling PWA-side audio.
 * The app relies on a native SpeechAudioPlayer for TTS.  When that path
 * fails (audio session conflicts, decode errors, etc.), the user hears
 * nothing because there is no fallback.
 *
 * These tests reproduce the issue and verify the fix: removing nativeApp=1
 * so the proven PWA audio path handles playback in the WKWebView.
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/** Generate a minimal valid WAV ArrayBuffer as eval-able source. */
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

test.describe("iOS native app TTS playback", () => {

  // ── Reproduction: nativeApp=1 blocks PWA audio (the bug) ──────────

  test("nativeApp=1 prevents PWA audio playback (reproduction of iOS bug)", async ({ page }) => {
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
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    // Load page with nativeApp=1, just like the iOS app does
    await page.goto(pageUrl("test-token") + "&nativeApp=1");
    await page.waitForFunction(() => !!window.__testWs);

    // Verify nativeAppHost is set
    const isNativeHost = await page.evaluate(() => nativeAppHost);
    expect(isNativeHost).toBe(true);

    // Send TTS via fake WebSocket
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Hello from overseer" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    // Wait a bit for any async processing
    await page.waitForTimeout(300);

    // Audio data IS stored (for replay button)
    const hasData = await page.evaluate(() => !!lastTtsAudioData);
    expect(hasData).toBe(true);

    // But NO audio plays — the PWA returns early from handleIncomingTtsAudio
    const playCalls = await page.evaluate(() => window.__playCalls.length);
    expect(playCalls).toBe(0);

    // The TTS queue is empty — nothing was enqueued for playback
    const queueLen = await page.evaluate(() => ttsPlaybackQueue.length);
    expect(queueLen).toBe(0);
  });

  // ── Fix verification: without nativeApp=1, PWA audio works ────────

  test("without nativeApp=1, PWA audio plays normally (the fix)", async ({ page }) => {
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
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    // Load page WITHOUT nativeApp=1 (the fix: iOS app stops passing it)
    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Verify nativeAppHost is NOT set
    const isNativeHost = await page.evaluate(() => nativeAppHost);
    expect(isNativeHost).toBe(false);

    // Send TTS via fake WebSocket
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Hello from overseer" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    // Audio DOES play through the PWA
    await expect.poll(() => page.evaluate(() => window.__playCalls.length)).toBe(1);
  });

  // ── Summary text still updates with nativeApp=1 ──────────────────

  test("speak_text still updates UI text even with nativeApp=1", async ({ page }) => {
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
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token") + "&nativeApp=1");
    await page.waitForFunction(() => !!window.__testWs);

    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Status: all workers idle" }) });
    });

    // Text IS displayed (Live Activity would show this)
    await expect(page.locator("#summary")).toHaveText("Status: all workers idle");
  });

  // ── Replay button works with nativeApp=1 ──────────────────────────

  test("replay button is enabled after TTS with nativeApp=1", async ({ page }) => {
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
          this.url = url;
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token") + "&nativeApp=1");
    await page.waitForFunction(() => !!window.__testWs);

    // Initially disabled
    const initialDisabled = await page.evaluate(() => {
      const btn = document.getElementById("voice-replay-btn");
      return btn ? btn.disabled : true;
    });
    expect(initialDisabled).toBe(true);

    // Send TTS
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Test" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateSilenceWavSource());

    // Replay button becomes enabled (audio data was stored)
    const afterDisabled = await page.evaluate(() => {
      const btn = document.getElementById("voice-replay-btn");
      return btn ? btn.disabled : true;
    });
    expect(afterDisabled).toBe(false);
  });
});
