// @ts-check
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl } = require("./helpers/config");

const FIXED_ENTRIES = [
  { text: "Latest summary line", timestamp: "2026-02-12T20:00:00.000Z" },
  { text: "Earlier summary line", timestamp: "2026-02-12T19:00:00.000Z" },
];

test.describe("Voice history modal", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      class FakeWebSocket {
        static OPEN = 1;

        constructor() {
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => {
            if (this.onopen) this.onopen();
            if (this.onmessage) {
              this.onmessage({ data: JSON.stringify({ type: "connected", captain: "codex" }) });
            }
          }, 0);
        }

        send(data) {
          window.__wsSent = window.__wsSent || [];
          window.__wsSent.push(data);
        }

        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose();
        }
      }

      window.WebSocket = FakeWebSocket;
    });

    await page.route("**/api/voice-history?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: FIXED_ENTRIES }),
      });
    });

    await page.route("**/api/speak", async (route) => {
      const body = route.request().postDataJSON();
      if (body && body.playbackOnly === true) {
        await route.fulfill({
          status: 200,
          contentType: "audio/ogg",
          body: Buffer.from([79, 103, 103, 83]), // tiny ogg header bytes for test-only playback path
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, clients: 1 }),
      });
    });
  });

  test("opens by clicking summary box", async ({ page }) => {
    await page.goto(pageUrl());

    await page.evaluate(() => {
      window.__testWs.onmessage({
        data: JSON.stringify({
          type: "speak_text",
          text: "Newest from websocket",
          timestamp: "2026-02-12T21:00:00.000Z",
        }),
      });
    });

    await page.click("#summary");
    await expect(page.locator("#voice-history-modal")).toBeVisible();
    await expect(page.locator(".voice-history-entry").first()).toContainText("Newest from websocket");
  });

  test("opens via history icon", async ({ page }) => {
    await page.goto(pageUrl());

    await page.click('[data-tab="voice"]');
    await page.click("#voice-history-modal-btn");

    await expect(page.locator("#voice-history-modal")).toBeVisible();
    await expect(page.locator(".voice-history-entry")).toHaveCount(2);
  });

  test("history list is scrollable with many entries", async ({ page }) => {
    await page.route("**/api/voice-history?**", async (route) => {
      const entries = Array.from({ length: 80 }, (_, i) => ({
        text: `Summary number ${i + 1} with long detail text to force scrolling.`,
        timestamp: `2026-02-12T18:${String(i % 60).padStart(2, "0")}:00.000Z`,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries }),
      });
    });

    await page.goto(pageUrl());
    await page.click('[data-tab="voice"]');
    await page.click("#voice-history-modal-btn");

    const metrics = await page.locator("#voice-history-list").evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  });

  test("closes with close button, escape key, and backdrop click", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="voice"]');

    await page.click("#voice-history-modal-btn");
    await expect(page.locator("#voice-history-modal")).toBeVisible();
    await page.click("#voice-history-close-btn");
    await expect(page.locator("#voice-history-modal")).toBeHidden();

    await page.click("#voice-history-modal-btn");
    await expect(page.locator("#voice-history-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#voice-history-modal")).toBeHidden();

    await page.click("#voice-history-modal-btn");
    await expect(page.locator("#voice-history-modal")).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(page.locator("#voice-history-modal")).toBeHidden();
  });

  test("clicking an entry triggers speak request", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click("#summary");

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/speak")),
      page.click(".voice-history-entry"),
    ]);

    const body = req.postDataJSON();
    expect(body.token).toBe(TOKEN);
    expect(body.text).toBe("Latest summary line");
  });

  test("clicking a history entry does not duplicate it in the modal list", async ({ page }) => {
    await page.goto(pageUrl());
    await page.click('[data-tab="voice"]');
    await page.click("#voice-history-modal-btn");

    await expect(page.locator(".voice-history-entry")).toHaveCount(2);

    await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/speak")),
      page.click(".voice-history-entry"),
    ]);

    await expect(page.locator(".voice-history-entry")).toHaveCount(2);
  });
});
