// @ts-check
/**
 * Comprehensive UI tests — Terminal tab, Voice tab, Status tab,
 * tab switching, controls, responsive layout.
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
    test("shows five tabs: Terminal, Screens, Summary, Done, Voice", async ({ page }) => {
      await page.goto(pageUrl());
      const tabs = page.locator("#tab-bar .tab");
      await expect(tabs).toHaveCount(5);
      await expect(tabs.nth(0)).toHaveText("Terminal");
      await expect(tabs.nth(1)).toHaveText("Screens");
      await expect(tabs.nth(2)).toHaveText("Summary");
      await expect(tabs.nth(3)).toHaveText("Done");
      await expect(tabs.nth(4)).toHaveText("Voice");
    });

    test("Terminal tab is active by default", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator('[data-tab="terminal"]')).toHaveClass(/active/);
      await expect(page.locator("#terminal-view")).toHaveClass(/active/);
    });

    test("clicking Screens tab switches to screens view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="screens"]');
      await expect(page.locator('[data-tab="screens"]')).toHaveClass(/active/);
      await expect(page.locator("#screens-view")).toHaveClass(/active/);
      await expect(page.locator("#terminal-view")).not.toHaveClass(/active/);
    });

    test("clicking Voice tab switches to voice view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator('[data-tab="voice"]')).toHaveClass(/active/);
      await expect(page.locator("#voice-view")).toHaveClass(/active/);
      await expect(page.locator("#terminal-view")).not.toHaveClass(/active/);
    });

    test("only one tab content visible at a time", async ({ page }) => {
      await page.goto(pageUrl());

      // Terminal active
      let visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);

      // Switch to Voice
      await page.click('[data-tab="voice"]');
      visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);

      // Switch to Screens
      await page.click('[data-tab="screens"]');
      visible = await page.locator(".tab-content.active").count();
      expect(visible).toBe(1);
    });

    test("switching back to Terminal from Voice restores view", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await page.click('[data-tab="terminal"]');
      await expect(page.locator("#terminal-view")).toHaveClass(/active/);
      await expect(page.locator("#controls")).not.toHaveClass(/hidden/);
    });
  });

  // ─── Terminal tab ────────────────────────────────────────────

  test.describe("Terminal tab", () => {
    test("terminal header shows title and status badge", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#terminal-title")).toHaveText("terminal");
      await expect(page.locator("#status")).toBeVisible();
    });

    test("connection status shows captain name when connected", async ({ page }) => {
      await page.goto(pageUrl());
      // Wait for WebSocket to connect
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });
      const text = await page.locator("#status").textContent();
      expect(["claude", "codex"]).toContain(text);
    });

    test("terminal pre element exists and is scrollable", async ({ page }) => {
      await page.goto(pageUrl());
      const terminal = page.locator("#terminal");
      await expect(terminal).toBeVisible();
      const overflow = await terminal.evaluate((el) => getComputedStyle(el).overflowY);
      expect(overflow).toBe("auto");
    });

    test("update/status button exists and is clickable", async ({ page }) => {
      await page.goto(pageUrl());
      const btn = page.locator("#update-btn");
      await expect(btn).toBeVisible();
      await expect(btn).toHaveText("Status");
      await expect(btn).toBeEnabled();
    });

    test("interrupt button exists with pause icon", async ({ page }) => {
      await page.goto(pageUrl());
      const btn = page.locator("#interrupt-btn");
      await expect(btn).toBeVisible();
      await expect(btn).toContainText("Interrupt");
      // Has SVG with two rects (pause icon)
      const rects = btn.locator("svg rect");
      await expect(rects).toHaveCount(2);
    });

    test("captain tool selector has claude and codex options", async ({ page }) => {
      await page.goto(pageUrl());
      const select = page.locator("#captain-tool-select");
      await expect(select).toBeVisible();
      const options = select.locator("option");
      await expect(options).toHaveCount(2);
      await expect(options.nth(0)).toHaveText("Claude");
      await expect(options.nth(1)).toHaveText("Codex");
    });

    test("restart button exists", async ({ page }) => {
      await page.goto(pageUrl());
      const btn = page.locator("#restart-captain-btn");
      await expect(btn).toBeVisible();
      await expect(btn).toHaveText("Restart");
    });

    test("summary panel exists with label", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#summary-label")).toHaveText("voice summary");
      await expect(page.locator("#summary")).toBeVisible();
    });

    test("transcription panel exists with label", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#transcription-label")).toHaveText("input transcription");
      await expect(page.locator("#transcription")).toBeVisible();
    });

    test("transcription panel is scrollable (not expanding)", async ({ page }) => {
      await page.goto(pageUrl());
      const panel = page.locator("#transcription");
      const maxHeight = await panel.evaluate((el) => getComputedStyle(el).maxHeight);
      // Should have max-height set (e.g. "4.5em")
      expect(maxHeight).not.toBe("none");
      const overflow = await panel.evaluate((el) => getComputedStyle(el).overflowY);
      expect(overflow).toBe("auto");
    });

    test("controls bar is visible with all elements", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#controls")).toBeVisible();
      await expect(page.locator("#mic-btn")).toBeVisible();
      await expect(page.locator("#text-input")).toBeVisible();
      await expect(page.locator("#send-btn")).toBeVisible();
      await expect(page.locator("#autoread-toggle")).toBeVisible();
    });

    test("text input has placeholder", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#text-input")).toHaveAttribute("placeholder", "Type a command...");
    });

    test("text popout button exists", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#text-popout-btn")).toBeVisible();
    });

    test("auto-read toggle checkbox works", async ({ page }) => {
      await page.goto(pageUrl());
      const cb = page.locator("#autoread-cb");

      // Default state (unchecked unless localStorage says otherwise)
      const initialState = await cb.isChecked();

      // Toggle it
      await page.locator("#autoread-toggle").click();
      const newState = await cb.isChecked();
      expect(newState).not.toBe(initialState);

      // Toggle back
      await page.locator("#autoread-toggle").click();
      const restored = await cb.isChecked();
      expect(restored).toBe(initialState);
    });

    test("captain selector updates color class on change", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      const select = page.locator("#captain-tool-select");
      await select.selectOption("codex");
      await expect(select).toHaveClass(/codex-selected/);

      await select.selectOption("claude");
      await expect(select).toHaveClass(/claude-selected/);
    });

    test("terminal receives content via WebSocket", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });
      // Wait for tmux_snapshot to populate terminal
      await page.waitForFunction(
        () => document.getElementById("terminal").textContent.length > 0,
        { timeout: 5000 },
      );
      const content = await page.locator("#terminal").textContent();
      expect(content.length).toBeGreaterThan(0);
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

    test("voice captain switch exists", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#voice-captain-tool-select")).toBeVisible();
      await expect(page.locator("#voice-restart-captain-btn")).toBeVisible();
      await expect(page.locator("#voice-restart-captain-btn")).toHaveText("Restart Captain");
    });

    test("controls bar hidden in voice tab", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');
      await expect(page.locator("#controls")).toHaveClass(/hidden/);
    });

    test("auto-read forced ON when entering voice tab", async ({ page }) => {
      await page.goto(pageUrl());
      // Make sure auto-read is OFF initially
      const cb = page.locator("#autoread-cb");
      if (await cb.isChecked()) {
        await page.locator("#autoread-toggle").click();
      }
      expect(await cb.isChecked()).toBe(false);

      // Enter voice tab
      await page.click('[data-tab="voice"]');
      expect(await cb.isChecked()).toBe(true);
    });

    test("auto-read restored when leaving voice tab", async ({ page }) => {
      await page.goto(pageUrl());
      const cb = page.locator("#autoread-cb");

      // Set auto-read OFF
      if (await cb.isChecked()) {
        await page.locator("#autoread-toggle").click();
      }
      expect(await cb.isChecked()).toBe(false);

      // Enter then leave voice tab
      await page.click('[data-tab="voice"]');
      expect(await cb.isChecked()).toBe(true);
      await page.click('[data-tab="terminal"]');
      expect(await cb.isChecked()).toBe(false);
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

    test("voice buttons are 140x140px", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="voice"]');

      for (const id of ["#voice-status-btn", "#voice-interrupt-btn", "#voice-mic-btn"]) {
        const box = await page.locator(id).boundingBox();
        expect(box.width).toBeCloseTo(140, -1);
        expect(box.height).toBeCloseTo(140, -1);
      }
    });

    test("voice captain selects sync with terminal captain selects", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      // Change in terminal tab
      await page.locator("#captain-tool-select").selectOption("codex");

      // Switch to voice tab and check
      await page.click('[data-tab="voice"]');
      const voiceVal = await page.locator("#voice-captain-tool-select").inputValue();
      expect(voiceVal).toBe("codex");

      // Change back
      await page.locator("#voice-captain-tool-select").selectOption("claude");
      await page.click('[data-tab="terminal"]');
      const termVal = await page.locator("#captain-tool-select").inputValue();
      expect(termVal).toBe("claude");
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

  // ─── Screens tab ─────────────────────────────────────────────

  test.describe("Screens tab", () => {
    test("screens tab loads with header elements", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="screens"]');

      await expect(page.locator("#status-title")).toHaveText("screens");
      await expect(page.locator("#status-time")).toBeVisible();
      // status-panes container exists in DOM (may be empty/hidden until data arrives)
      await expect(page.locator("#status-panes")).toBeAttached();
    });

    test("screens body is scrollable", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="screens"]');

      const overflow = await page.locator("#status-body").evaluate(
        (el) => getComputedStyle(el).overflowY,
      );
      expect(overflow).toBe("auto");
    });
  });

  // ─── Summary tab ────────────────────────────────────────────

  test.describe("Summary tab", () => {
    test("summary tab loads with header and refresh button", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="summary"]');

      await expect(page.locator("#summary-tab-title")).toHaveText("summary");
      await expect(page.locator("#refresh-summary-btn")).toBeVisible();
      await expect(page.locator("#summary-tab-content")).toBeVisible();
    });

    test("summary body is scrollable", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="summary"]');

      const overflow = await page.locator("#summary-tab-body").evaluate(
        (el) => getComputedStyle(el).overflowY,
      );
      expect(overflow).toBe("auto");
    });
  });

  // ─── Completed tab ──────────────────────────────────────────

  test.describe("Completed tab", () => {
    test("completed tab loads with header and refresh button", async ({ page }) => {
      await page.goto(pageUrl());
      await page.click('[data-tab="completed"]');

      await expect(page.locator("#completed-tab-title")).toHaveText("completed tasks");
      await expect(page.locator("#refresh-completed-btn")).toBeVisible();
      await expect(page.locator("#completed-tab-content")).toBeVisible();
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
                completed_at: "2026-02-11T09:43:00Z",
                short_summary: "Refactored bridge and added tests.",
                detailed_summary: "## Completed\n- Added API route\n```js\nconsole.log('ok')\n```",
                task_definition: "### Original Task\n- Fix bridge",
                worker_type: "codex",
                session: "challenges",
                window: "v8-redo",
              },
            ],
          }),
        });
      });

      await page.goto(pageUrl());
      await page.click('[data-tab="completed"]');
      await expect(page.locator(".completed-task-item")).toHaveCount(1);
      await expect(page.locator(".completed-task-short")).toHaveText("Refactored bridge and added tests.");

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
    test("interrupt button sends POST /api/interrupt", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      // Intercept the fetch call
      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/api/interrupt")),
        page.click("#interrupt-btn"),
      ]);

      expect(request.method()).toBe("POST");
      const body = request.postDataJSON();
      expect(body.token).toBe(TOKEN);
    });

    test("voice interrupt button sends POST /api/interrupt", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });
      await page.click('[data-tab="voice"]');

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/api/interrupt")),
        page.click("#voice-interrupt-btn"),
      ]);

      expect(request.method()).toBe("POST");
    });

    test("status/update button sends text_command via WebSocket", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      // Listen for WS message
      const sent = page.evaluate(() => {
        return new Promise((resolve) => {
          const origSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            if (typeof data === "string") {
              try {
                const msg = JSON.parse(data);
                if (msg.type === "text_command" && msg.text.includes("status update")) {
                  WebSocket.prototype.send = origSend;
                  resolve(msg);
                }
              } catch {}
            }
            return origSend.call(this, data);
          };
        });
      });

      await page.click("#update-btn");
      const msg = await sent;
      expect(msg.type).toBe("text_command");
      expect(msg.text).toContain("status update");
    });

    test("send button sends text from input field", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      const sent = page.evaluate(() => {
        return new Promise((resolve) => {
          const origSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            if (typeof data === "string") {
              try {
                const msg = JSON.parse(data);
                if (msg.type === "text_command" && msg.text === "test-ping") {
                  WebSocket.prototype.send = origSend;
                  resolve(msg);
                }
              } catch {}
            }
            return origSend.call(this, data);
          };
        });
      });

      await page.fill("#text-input", "test-ping");
      await page.click("#send-btn");
      const msg = await sent;
      expect(msg.text).toBe("test-ping");
    });

    test("restart button sends POST /api/restart-captain with correct body", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/api/restart-captain")),
        page.click("#restart-captain-btn"),
      ]);

      expect(request.method()).toBe("POST");
      const body = request.postDataJSON();
      expect(body.token).toBe(TOKEN);
      expect(["claude", "codex"]).toContain(body.tool);
    });

    test("restart button shows 'Restarting...' while in progress", async ({ page }) => {
      // Intercept the restart API to add a delay so we can check the button text
      await page.route("**/api/restart-captain", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, tool: "claude" }),
        });
      });

      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      // Click restart, then immediately check the button text
      page.click("#restart-captain-btn"); // don't await — we need to check mid-flight
      await expect(page.locator("#restart-captain-btn")).toHaveText("Restarting...");
      await expect(page.locator("#restart-captain-btn")).toBeDisabled();

      // Wait for it to finish and re-enable
      await expect(page.locator("#restart-captain-btn")).toHaveText("Restart", { timeout: 5000 });
      await expect(page.locator("#restart-captain-btn")).toBeEnabled();
    });

    test("restart button shows error message on failure", async ({ page }) => {
      await page.route("**/api/restart-captain", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "tmux session not found" }),
        });
      });

      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      await page.click("#restart-captain-btn");

      // Should show the error in the summary area
      await expect(page.locator("#summary")).toContainText("tmux session not found", { timeout: 5000 });
      // Button should be re-enabled
      await expect(page.locator("#restart-captain-btn")).toBeEnabled();
    });

    test("voice restart button sends POST /api/restart-captain", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });
      await page.click('[data-tab="voice"]');

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/api/restart-captain")),
        page.click("#voice-restart-captain-btn"),
      ]);

      expect(request.method()).toBe("POST");
      const body = request.postDataJSON();
      expect(body.token).toBe(TOKEN);
      expect(["claude", "codex"]).toContain(body.tool);
    });

    test("restart button shows success in summary", async ({ page }) => {
      await page.route("**/api/restart-captain", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, tool: "claude" }),
        });
      });

      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      await page.click("#restart-captain-btn");

      await expect(page.locator("#summary")).toContainText("Captain restarted", { timeout: 5000 });
    });

    test("Enter key in text input sends command", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      const sent = page.evaluate(() => {
        return new Promise((resolve) => {
          const origSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            if (typeof data === "string") {
              try {
                const msg = JSON.parse(data);
                if (msg.type === "text_command" && msg.text === "enter-test") {
                  WebSocket.prototype.send = origSend;
                  resolve(msg);
                }
              } catch {}
            }
            return origSend.call(this, data);
          };
        });
      });

      await page.fill("#text-input", "enter-test");
      await page.press("#text-input", "Enter");
      const msg = await sent;
      expect(msg.text).toBe("enter-test");
    });

    test("text input is cleared after sending", async ({ page }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      await page.fill("#text-input", "clear-test");
      await page.click("#send-btn");

      // Input should be cleared
      await expect(page.locator("#text-input")).toHaveValue("");
    });

    test("popout opens with current input and closes preserving text", async ({ page }) => {
      await page.goto(pageUrl());

      await page.fill("#text-input", "draft text");
      await page.click("#text-popout-btn");

      await expect(page.locator("#text-popout-modal")).toBeVisible();
      await expect(page.locator("#text-popout-textarea")).toHaveValue("draft text");

      await page.fill("#text-popout-textarea", "updated draft");
      await page.click("#text-popout-cancel-btn");

      await expect(page.locator("#text-popout-modal")).toBeHidden();
      await expect(page.locator("#text-input")).toHaveValue("updated draft");
    });

    test("Ctrl+Enter in popout sends command and closes modal", async ({ page, browserName }) => {
      await page.goto(pageUrl());
      await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

      const sent = page.evaluate(() => {
        return new Promise((resolve) => {
          const origSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            if (typeof data === "string") {
              try {
                const msg = JSON.parse(data);
                if (msg.type === "text_command" && msg.text === "popout-send") {
                  WebSocket.prototype.send = origSend;
                  resolve(msg);
                }
              } catch {}
            }
            return origSend.call(this, data);
          };
        });
      });

      await page.click("#text-popout-btn");
      await page.fill("#text-popout-textarea", "popout-send");
      if (browserName === "webkit") {
        await page.press("#text-popout-textarea", "Meta+Enter");
      } else {
        await page.press("#text-popout-textarea", "Control+Enter");
      }

      const msg = await sent;
      expect(msg.text).toBe("popout-send");
      await expect(page.locator("#text-popout-modal")).toBeHidden();
      await expect(page.locator("#text-input")).toHaveValue("");
    });
  });

  // ─── Responsive layout ──────────────────────────────────────

  test.describe("Responsive layout", () => {
    test("renders correctly on mobile viewport (375x667)", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(pageUrl());

      // Tab bar visible
      await expect(page.locator("#tab-bar")).toBeVisible();

      // Controls visible
      await expect(page.locator("#controls")).toBeVisible();

      // Terminal visible
      await expect(page.locator("#terminal")).toBeVisible();

      // All control buttons accessible
      await expect(page.locator("#mic-btn")).toBeVisible();
      await expect(page.locator("#send-btn")).toBeVisible();
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
      await expect(page.locator("#terminal")).toBeVisible();
    });

    test("renders correctly on tablet viewport (768x1024)", async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(pageUrl());

      await expect(page.locator("#tab-bar")).toBeVisible();
      await expect(page.locator("#terminal")).toBeVisible();
      await expect(page.locator("#controls")).toBeVisible();
    });

    test("body does not scroll (app uses flex layout)", async ({ page }) => {
      await page.goto(pageUrl());
      const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
      expect(overflow).toBe("hidden");
    });
  });
});
