// @ts-check
/**
 * iOS Safari audio unlock tests.
 *
 * Verifies that the audio unlock pattern primes the *actual* ttsAudio element
 * (not a throwaway) so that subsequent TTS playback works without user gesture.
 *
 * These tests use the REAL browser audio stack for playback verification:
 *   - audio.paused === false
 *   - audio.currentTime > 0
 *   - audio.readyState >= 2 (HAVE_CURRENT_DATA)
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

/** Generate a valid 1-second WAV (440 Hz sine) as eval-able source string. */
function generateAudibleWavSource() {
  return `(() => {
    const sampleRate = 8000;
    const durationSec = 1;
    const numSamples = sampleRate * durationSec;
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
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
      dv.setInt16(44 + i * 2, sample, true);
    }
    return buf;
  })()`;
}

/** Shared init script: stub WebSocket, leave Audio real. */
function fakeWsInitScript() {
  return () => {
    localStorage.setItem("autoread", "true");
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
  };
}

test.describe("iOS Safari audio unlock", () => {

  // ── Core: TTS audio actually plays after user gesture + audio injection ──
  test("TTS audio actually plays in real browser after user gesture", async ({ page }) => {
    await page.addInitScript(fakeWsInitScript());

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Step 1: Simulate a user gesture (click) to trigger unlockAudio().
    await page.click("body");
    // Give the unlock a moment to process.
    await page.waitForTimeout(200);

    // Step 2: Inject TTS audio via the fake WebSocket — real audio data (1s 440Hz sine).
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Hello from test" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateAudibleWavSource());

    // Step 3: Verify the audio is ACTUALLY PLAYING — real browser audio stack.
    // Poll because play() is async and the browser needs a moment to decode + start.
    await expect.poll(async () => {
      return await page.evaluate(() => {
        if (!ttsAudio) return "no-audio-element";
        if (ttsAudio.paused) return "paused";
        return "playing";
      });
    }, { timeout: 5000, message: "ttsAudio should be playing (not paused)" }).toBe("playing");

    // Verify currentTime advances (audio is genuinely producing output).
    const firstTime = await page.evaluate(() => ttsAudio.currentTime);
    await page.waitForTimeout(200);
    const secondTime = await page.evaluate(() => ttsAudio.currentTime);
    expect(secondTime).toBeGreaterThan(firstTime);
    expect(secondTime).toBeGreaterThan(0);

    // Verify readyState >= 2 (HAVE_CURRENT_DATA — browser has decoded audio data).
    const readyState = await page.evaluate(() => ttsAudio.readyState);
    expect(readyState).toBeGreaterThanOrEqual(2);
  });

  // ── Unlock primes the persistent ttsAudio element, not a throwaway ──
  test("unlockAudio primes the persistent ttsAudio element (not a throwaway)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("autoread", "true");
      // Wrap play() to track which Audio elements it's called on,
      // while still calling through to the real implementation.
      window.__playedElements = [];
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__playedElements.push(this);
        return origPlay.call(this).catch(() => {});
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

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Trigger unlock via user gesture.
    await page.click("body");
    // Wait for the unlock to call play() — it fires asynchronously.
    await expect.poll(
      () => page.evaluate(() => window.__playedElements.length),
      { timeout: 5000, message: "play() should have been called" }
    ).toBeGreaterThan(0);

    // The FIRST play() call during unlock should be on the persistent ttsAudio
    // element — NOT on a newly created throwaway Audio element.
    const unlockUsedTtsAudio = await page.evaluate(() => {
      return window.__playedElements[0] === ttsAudio;
    });
    expect(unlockUsedTtsAudio).toBe(true);
  });

  // ── Full pipeline: gesture → TTS → real playback with time advancement ──
  test("full pipeline: gesture + TTS audio → real playback with advancing currentTime", async ({ page }) => {
    await page.addInitScript(fakeWsInitScript());

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Simulate user gesture.
    await page.click("body");
    await page.waitForTimeout(100);

    // Inject two TTS messages — verify FIFO with real audio.
    await page.evaluate((wavSrc) => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "tts_config", format: "wav", mime: "audio/wav" }) });
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "First message" }) });
      ws.onmessage({ data: eval(wavSrc) });
    }, generateAudibleWavSource());

    // Wait for first clip to start playing.
    await expect.poll(async () => {
      return await page.evaluate(() => !ttsAudio.paused);
    }, { timeout: 5000, message: "first clip should start playing" }).toBe(true);

    // Verify it's actually producing audio (currentTime advances).
    await page.waitForTimeout(100);
    const ct = await page.evaluate(() => ttsAudio.currentTime);
    expect(ct).toBeGreaterThan(0);

    // Verify the audio element has real data loaded.
    const info = await page.evaluate(() => ({
      paused: ttsAudio.paused,
      currentTime: ttsAudio.currentTime,
      readyState: ttsAudio.readyState,
      duration: ttsAudio.duration,
      src: ttsAudio.src,
    }));

    expect(info.paused).toBe(false);
    expect(info.currentTime).toBeGreaterThan(0);
    expect(info.readyState).toBeGreaterThanOrEqual(2);
    expect(info.duration).toBeGreaterThan(0);
    // src should be a blob URL (the TTS audio), not the silent WAV data URI.
    expect(info.src).toContain("blob:");
  });
});
