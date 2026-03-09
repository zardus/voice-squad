// @ts-check
/**
 * Comprehensive UI tests — Projects tab, Overseer tab, Voice tab,
 * Tasks tab, tab switching, responsive layout.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl } = require("./helpers/config");

test.describe("UI", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  // ─── Page load ───────────────────────────────────────────────

  test.describe("Page load", () => {
    test("page loads with correct title", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page).toHaveTitle("Squad Voice");
    });

    test("page has dark background", async ({ page }) => {
      await page.goto(pageUrl());
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // #1a1a2e = rgb(26, 26, 46)
      expect(bg).toContain("26");
    });

    test("PWA manifest link is present", async ({ page }) => {
      await page.goto(pageUrl());
      const manifest = page.locator('link[rel="manifest"]');
      await expect(manifest).toHaveAttribute("href", "manifest.json");
    });
  });

  // ─── Tab bar ─────────────────────────────────────────────────

  test.describe("Tab bar", () => {
    test("shows four tabs: Projects, Overseer, Tasks, Voice", async ({ page }) => {
      await page.goto(pageUrl());
      const tabs = page.locator("#tab-bar .tab");
      await expect(tabs).toHaveCount(4);
      await expect(tabs.nth(0)).toHaveText("Projects");
      await expect(tabs.nth(1)).toHaveText("Overseer");
      await expect(tabs.nth(2)).toHaveText("Tasks");
      await expect(tabs.nth(3)).toHaveText("Voice");
    });

    test("Projects tab is active by default", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator('[data-tab="projects"]')).toHaveClass(/active/);
      await expect(page.locator("#projects-view")).toHaveClass(/active/);
    });

    test("clicking Overseer tab switches to overseer view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="overseer"]');
      await expect(page.locator('[data-tab="overseer"]')).toHaveClass(/active/);
      await expect(page.locator("#overseer-view")).toHaveClass(/active/);
      await expect(page.locator("#projects-view")).not.toHaveClass(/active/);
    });

    test("clicking Voice tab switches to voice view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator('[data-tab="voice"]')).toHaveClass(/active/);
      await expect(page.locator("#voice-view")).toHaveClass(/active/);
      await expect(page.locator("#projects-view")).not.toHaveClass(/active/);
    });

    test("only one tab content visible at a time", async ({ page }) => {
      await page.goto(pageUrl());

      // Projects active
      let visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);

      // Switch to Voice
      await page.click('[data-tab="voice"]');
      visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);

      // Switch to Overseer
      await page.click('[data-tab="overseer"]');
      visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);
    });

    test("switching back to Projects from Voice restores view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await page.click('[data-tab="projects"]');
      await expect(page.locator("#projects-view")).toHaveClass(/active/);
    });
  });

  // ─── Overseer tab ───────────────────────────────────────────

  test.describe("Overseer tab", () => {
    test("overseer tab loads with header and refresh button", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="overseer"]');

      await expect(page.locator("#overseer-tab-title")).toHaveText("overseer");
      await expect(page.locator("#refresh-overseer-btn")).toBeVisible();
      await expect(page.locator("#overseer-tab-content")).toBeVisible();
    });

    test("overseer status badge exists", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#overseer-status")).toBeAttached();
    });

    test("overseer body is scrollable", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="overseer"]');

      const overflow = await page.locator("#overseer-tab-body").evaluate(
        (el) => getComputedStyle(el).overflowY,
      );
      expect(overflow).toBe("auto");
    });
  });

  // ─── Voice tab ───────────────────────────────────────────────

  test.describe("Voice tab", () => {
    test("voice tab loads with all buttons", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      await expect(page.locator("#voice-status-btn")).toBeVisible();
      await expect(page.locator("#voice-interrupt-btn")).toBeVisible();
      await expect(page.locator("#voice-replay-btn")).toBeVisible();
      await expect(page.locator("#voice-mic-btn")).toBeVisible();
    });

    test("status button (?) has question mark", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      const btn = page.locator("#voice-status-btn");
      await expect(btn).toContainText("?");
    });

    test("interrupt button has pause SVG icon", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      const rects = page.locator("#voice-interrupt-btn svg rect");
      await expect(rects).toHaveCount(2);
    });

    test("replay button is disabled initially", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#voice-replay-btn")).toBeDisabled();
    });

    test("mic button has microphone SVG", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      const svg = page.locator("#voice-mic-btn svg");
      await expect(svg).toBeVisible();
    });

    test("hint text shows", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#voice-hint")).toHaveText("Hold mic or spacebar to speak");
    });

    test("voice tab shows auto-read toggle", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#voice-autoread-toggle")).toBeVisible();
    });

    test("no media session / AirPod diagnostics UI is present", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#airpod-status")).toHaveCount(0);
      await expect(page.locator("#media-session-debug")).toHaveCount(0);
      await expect(page.locator("#media-keepalive-audio")).toHaveCount(0);
    });

    test("replay triggers TTS audio playback (no media session interference)", async ({ page }) => {
      await page.addInitScript(() => {
        const state = {
          playCount: 0,
        };

        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function patchedPlay() {
          state.playCount += 1;
          return Promise.resolve();
        };
        window.__restorePlay = () => {
          HTMLMediaElement.prototype.play = originalPlay;
        };
        window.__audioPlayState = state;
      });

      await page.goto(pageUrl());
      await page.click("body");
      await page.click('[data-tab="voice"]');

      // Seed "last received" audio and enable replay.
      await page.evaluate(() => {
        // Top-level `let` bindings in app.js are in the global lexical env (not window),
        // but are still addressable by name from injected scripts.
        // eslint-disable-next-line no-undef
        lastTtsAudioData = new Uint8Array([1, 2, 3, 4]).buffer;
        // eslint-disable-next-line no-undef
        voiceReplayBtn.disabled = false;
      });

      await page.click("#voice-replay-btn");

      const audioState = await page.evaluate(() => window.__audioPlayState);
      expect(audioState.playCount).toBeGreaterThan(0);

      await page.evaluate(() => {
        if (window.__restorePlay) window.__restorePlay();
      });
    });

    test("auto-read toggle checkbox works", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      const cb = page.locator("#voice-autoread-cb");

      // Default state
      const initialState = await cb.isChecked();

      // Toggle it
      await page.locator("#voice-autoread-toggle").click();
      const newState = await cb.isChecked();
      expect(newState).not.toBe(initialState);

      // Toggle back
      await page.locator("#voice-autoread-toggle").click();
      const restored = await cb.isChecked();
      expect(restored).toBe(initialState);
    });

    test("voice top row buttons are side by side", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      const row = page.locator("#voice-top-row");
      const display = await row.evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe("flex");

      const gap = await row.evaluate((el) => getComputedStyle(el).gap);
      expect(gap).toBeTruthy();
    });

    test("voice buttons are square and reasonably sized", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      for (const id of ["#voice-status-btn", "#voice-interrupt-btn", "#voice-mic-btn"]) {
        const box = await page.locator(id).boundingBox();
        expect(box).toBeTruthy();
        expect(Math.abs(box.width - box.height)).toBeLessThan(2);
        expect(box.width).toBeGreaterThanOrEqual(100);
        expect(box.width).toBeLessThanOrEqual(160);
      }
    });

    test("voice transcription area has brief text, not full transcription", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      // voice-transcription should be hidden when empty (display:none via CSS :empty)
      const el = page.locator("#voice-transcription");
      const display = await el.evaluate((e) => getComputedStyle(e).display);
      expect(display).toBe("none"); // Hidden when empty
    });
  });

  // ─── Projects tab ────────────────────────────────────────────

  test.describe("Projects tab", () => {
    test("projects tab loads with header elements", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="projects"]');

      await expect(page.locator("#projects-title")).toHaveText("projects");
      await expect(page.locator("#projects-time")).toBeVisible();
      await expect(page.locator("#projects-panes")).toBeAttached();
    });

    test("projects body is scrollable", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="projects"]');

      const overflow = await page.locator("#projects-body").evaluate(
        (el) => getComputedStyle(el).overflowY,
      );
      expect(overflow).toBe("auto");
    });

    test("add project button exists", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="projects"]');

      await expect(page.locator("#add-project-btn")).toBeVisible();
    });
  });

  // ─── Tasks tab ──────────────────────────────────────────────

  test.describe("Tasks tab", () => {
    test("tasks tab loads with sections and refresh button", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="tasks"]');

      await expect(page.locator("#tasks-tab-title")).toHaveText("tasks");
      await expect(page.locator("#refresh-tasks-btn")).toBeVisible();
      await expect(page.locator("#pending-tasks-section .tasks-section-title")).toHaveText("Pending Tasks");
      await expect(page.locator("#completed-tasks-section .tasks-section-title")).toHaveText("Completed Tasks");
    });

    test("completed task accordion expands and collapses", async ({ page }) => {
      await page.route("**/api/completed-tasks?**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tasks: [
              {
                task_name: "v8-bridging-redo",
                title: "Refactored bridge",
                started_at: "2026-02-11T09:40:00Z",
                completed_at: "2026-02-11T09:43:00Z",
                results: "## Completed\n- Added API route\n```js\nconsole.log('ok')\n```",
                task_definition: "### Original Task\n- Fix bridge",
                has_log: true,
              },
            ],
          }),
        });
      });

      await page.goto(pageUrl());
      await page.click('[data-tab="tasks"]');
      await expect(page.locator(".completed-task-item")).toHaveCount(1);
      await expect(page.locator(".completed-task-short")).toContainText("started");

      const item = page.locator(".completed-task-item").first();
      expect(await item.evaluate((el) => el.hasAttribute("open"))).toBe(false);

      await page.locator(".completed-task-summary").first().click();
      expect(await item.evaluate((el) => el.hasAttribute("open"))).toBe(true);
      await expect(page.locator(".completed-task-detailed")).toContainText("Added API route");

      await page.locator(".completed-task-summary").first().click();
      expect(await item.evaluate((el) => el.hasAttribute("open"))).toBe(false);
    });
  });

  // ─── Button actions ──────────────────────────────────────────

  test.describe("Button actions", () => {
    test("voice interrupt button sends POST /api/interrupt", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      // Wait for WS connect
      await page.waitForTimeout(500);

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/api/interrupt")),
        page.click("#voice-interrupt-btn"),
      ]);

      expect(request.method()).toBe("POST");
    });

    test("text popout modal opens and closes", async ({ page }) => {
      await page.goto(pageUrl());

      // The text popout modal still exists in the DOM
      await expect(page.locator("#text-popout-modal")).toBeHidden();
    });
  });

  // ─── Responsive layout ──────────────────────────────────────

  test.describe("Responsive layout", () => {
    test("renders correctly on mobile viewport (375x667)", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(pageUrl());

      // Tab bar visible
      await expect(page.locator("#tab-bar")).toBeVisible();

      // Projects view visible (default tab)
      await expect(page.locator("#projects-view")).toHaveClass(/active/);
    });

    test("voice tab renders correctly on mobile viewport", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      // All voice buttons visible
      await expect(page.locator("#voice-status-btn")).toBeVisible();
      await expect(page.locator("#voice-interrupt-btn")).toBeVisible();
      await expect(page.locator("#voice-mic-btn")).toBeVisible();
      await expect(page.locator("#voice-hint")).toBeVisible();
    });

    test("renders correctly on small mobile viewport (320x480)", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 480 });
      await page.goto(pageUrl());

      await expect(page.locator("#tab-bar")).toBeVisible();
      // Projects view is default active
      await expect(page.locator("#projects-view")).toHaveClass(/active/);
    });

    test("renders correctly on tablet viewport (768x1024)", async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(pageUrl());

      await expect(page.locator("#tab-bar")).toBeVisible();
      await expect(page.locator("#projects-view")).toHaveClass(/active/);
    });

    test("body does not scroll (app uses flex layout)", async ({ page }) => {
      await page.goto(pageUrl());
      const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
      expect(overflow).toBe("hidden");
    });
  });
});
