// @ts-check
/**
 * Screenshot generator for README — produces polished mobile screenshots
 * of all PWA tabs with realistic mock data injected.
 *
 * Run via: npx playwright test tests/screenshots.spec.js
 * Output:  /tmp/screenshots/*.png
 */
const { test } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");
const fs = require("fs");

const SCREENSHOT_DIR = "/tmp/screenshots";

const SUMMARY_TEXT =
  "Two workers dispatched for the auth service refactor. First worker is handling JWT validation and refresh token rotation. Second is writing integration tests for the auth endpoints. Both are making good progress.";

// Status tab: live stream panes
const STATUS_PANES = [
  {
    session: "auth-service",
    window: "worker-1",
    snippet: `╭──────────────────────────────────────────╮
│ Claude Code — Worker                     │
╰──────────────────────────────────────────╯

> I'll refactor the JWT validation module and add
  refresh token rotation.

⏺ Reading src/auth/jwt.ts

⏺ Editing src/auth/jwt.ts
  - Added rotateRefreshToken() function
  - Updated validateToken() to check expiry window
  - Added REFRESH_TOKEN_TTL constant

⏺ Reading src/middleware/auth.ts

⏺ Editing src/middleware/auth.ts
  - Updated middleware to call rotateRefreshToken()
    when token is within 5 min of expiry`,
  },
  {
    session: "auth-service",
    window: "worker-2",
    snippet: `╭──────────────────────────────────────────╮
│ Claude Code — Worker                     │
╰──────────────────────────────────────────╯

> Writing integration tests for the auth endpoints.

⏺ Creating tests/auth.integration.test.ts

⏺ Writing tests:
  ✓ POST /auth/login — valid credentials
  ✓ POST /auth/login — invalid password
  ✓ POST /auth/register — new user
  ✓ GET /auth/me — with valid token
  ◯ POST /auth/refresh — token rotation
  ◯ POST /auth/logout — invalidate session
  ◯ GET /auth/me — with expired token`,
  },
  {
    session: "frontend-app",
    window: "worker-3",
    snippet: `╭──────────────────────────────────────────╮
│ Claude Code — Worker                     │
╰──────────────────────────────────────────╯

> Migration complete. All tests passing.

⏺ Finished migrating Dashboard component
  - Converted class component to functional
  - Replaced lifecycle methods with useEffect hooks
  - Added useMemo for expensive computations
  - All 12 existing tests passing

⏺ Running: npm test -- --testPathPattern dashboard
  PASS src/components/__tests__/Dashboard.test.tsx
  Tests: 12 passed, 12 total
  Time:  2.341s`,
  },
];

test.describe("Screenshots", () => {
  test.use({
    viewport: { width: 390, height: 844 },
  });

  test("capture all tabs", async ({ page }) => {
    // Stub WebSocket so the app doesn't try to connect for real
    await page.addInitScript(() => {
      class FakeWebSocket {
        static OPEN = 1;
        constructor() {
          this.readyState = FakeWebSocket.OPEN;
          this.bufferedAmount = 0;
          this.binaryType = "arraybuffer";
          window.__testWs = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send() {}
        close() {}
      }
      window.WebSocket = FakeWebSocket;
    });

    await page.goto(pageUrl("test-token"));
    await page.waitForFunction(() => !!window.__testWs);

    // Ensure screenshot output directory exists
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // ── Projects Tab (default) ─────────────────────────────────
    await page.evaluate(
      ({ panes }) => {
        document.getElementById("projects-time").textContent = "\u25cf LIVE";
        document.getElementById("projects-time").className = "live-indicator";

        const panesEl = document.getElementById("projects-panes");
        panesEl.innerHTML = "";
        for (const pane of panes) {
          const panel = document.createElement("div");
          panel.className = "stream-panel";

          const header = document.createElement("div");
          header.className = "stream-panel-header";
          header.textContent = `${pane.session} / ${pane.window}`;
          panel.appendChild(header);

          const pre = document.createElement("pre");
          pre.className = "stream-panel-content";
          pre.textContent = pane.snippet;
          panel.appendChild(pre);

          panesEl.appendChild(panel);
        }
      },
      { panes: STATUS_PANES }
    );

    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/projects-tab.png`,
      type: "png",
    });

    // ── Overseer Tab ──────────────────────────────────────────
    await page.click('[data-tab="overseer"]');
    await page.waitForTimeout(100);

    // Set connected status
    await page.evaluate(() => {
      const statusEl = document.getElementById("overseer-status");
      if (statusEl) {
        statusEl.textContent = "claude";
        statusEl.className = "connected";
      }
    });

    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/overseer-tab.png`,
      type: "png",
    });

    // ── Voice Tab ────────────────────────────────────────────
    await page.click('[data-tab="voice"]');
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      const el = document.getElementById("voice-transcription");
      el.textContent = "How are the workers doing on the auth service?";
      el.className = "voice-transcription";

      // Enable the replay button to make it look like there's been activity
      document.getElementById("voice-replay-btn").disabled = false;
    });

    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/voice-tab.png`,
      type: "png",
    });
  });
});
