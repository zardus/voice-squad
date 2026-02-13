// @ts-check
/**
 * Auto-read behavior tests.
 *
 * We stub WebSocket and Audio playback so we can deterministically assert
 * whether incoming TTS audio would autoplay based on the UI toggle, without
 * calling external APIs.
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

test.describe("Auto-read", () => {
  test("auto-read toggle controls whether incoming TTS audio autoplays", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await page.addInitScript(() => {
      // Ensure a known starting value before app.js reads localStorage.
      localStorage.setItem("autoread", "false");

      // Track "play" calls.
      window.__playCount = 0;
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function play() {
        window.__playCount++;
        // Simulate successful autoplay to keep behavior deterministic.
        return Promise.resolve();
      };
      // Keep a reference in case debugging is needed.
      window.__origPlay = origPlay;

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

    const cb = page.locator("#autoread-cb");
    await expect(cb).not.toBeChecked();

    // Inject a "speak_text" then binary audio. With auto-read OFF, nothing should autoplay.
    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({ data: JSON.stringify({ type: "speak_text", text: "Hello" }) });
      ws.onmessage({ data: new ArrayBuffer(16) });
    });
    await expect.poll(async () => page.evaluate(() => window.__playCount)).toBe(0);

    // Toggle auto-read ON and inject another summary + Blob audio; it should autoplay once.
    await page.locator("#autoread-toggle").click();
    await expect(cb).toBeChecked();
    const before = await page.evaluate(() => window.__playCount);

    await page.evaluate(() => {
      const ws = window.__testWs;
      ws.onmessage({
        data: JSON.stringify({
          type: "speak_text",
          text: "Auto-read summary should speak",
          timestamp: "2026-02-12T21:00:00.000Z",
        }),
      });
      ws.onmessage({ data: new Blob([new Uint8Array([79, 103, 103, 83])], { type: "audio/ogg" }) });
    });

    await expect
      .poll(async () => page.evaluate(() => window.__playCount))
      .toBe(before + 1);
  });
});
