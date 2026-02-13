// @ts-check
/**
 * Auto Listen behavior tests.
 *
 * We stub getUserMedia so we can assert:
 * - No mic pre-acquire when autolisten is false
 * - Turning autolisten OFF stops tracks and prevents re-acquire on user gestures
 */
const { test, expect } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");

test.describe("Auto Listen", () => {
  test("autolisten=false does not pre-acquire mic (even after user gestures)", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await page.addInitScript(() => {
      localStorage.setItem("autolisten", "false");

      window.__gumCalls = 0;
      navigator.mediaDevices = navigator.mediaDevices || {};
      navigator.mediaDevices.getUserMedia = async () => {
        window.__gumCalls += 1;
        const track = {
          readyState: "live",
          stop() { this.readyState = "ended"; },
        };
        return { getTracks: () => [track] };
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

    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);

    // User gesture should not re-acquire when Auto Listen is OFF.
    await page.click("body");
    await page.waitForTimeout(50);
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(0);
  });

  test("turning Auto Listen OFF stops tracks and prevents background re-acquire", async ({ page }) => {
    if (process.env.PW_PAGE_DEBUG) {
      page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`[pageerror] ${err && err.stack ? err.stack : String(err)}`));
    }

    await page.addInitScript(() => {
      localStorage.setItem("autolisten", "true");

      window.__gumCalls = 0;
      window.__stopCount = 0;
      navigator.mediaDevices = navigator.mediaDevices || {};
      navigator.mediaDevices.getUserMedia = async () => {
        window.__gumCalls += 1;
        const track = {
          readyState: "live",
          stop() {
            window.__stopCount += 1;
            this.readyState = "ended";
          },
        };
        return { getTracks: () => [track] };
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

    // In Playwright, the app intentionally skips mic pre-acquire on user gestures
    // when `navigator.webdriver` is true. Force acquisition directly.
    await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await ensureMicStream();
    });
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(1);

    // Toggle OFF: must stop tracks and release mic.
    await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await setAutoListenEnabled(false);
    });
    await expect.poll(async () => page.evaluate(() => window.__stopCount)).toBe(1);

    // Subsequent gestures should not re-acquire.
    await page.click("body");
    await page.waitForTimeout(50);
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(1);

    // Toggle back ON: should re-acquire.
    await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await setAutoListenEnabled(true, { acquire: true });
    });
    await expect.poll(async () => page.evaluate(() => window.__gumCalls)).toBe(2);
  });
});
