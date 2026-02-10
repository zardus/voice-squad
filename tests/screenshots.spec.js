// @ts-check
/**
 * Screenshot generator for README — produces polished mobile screenshots
 * of all three PWA tabs with realistic mock data injected.
 *
 * Run via: npx playwright test tests/screenshots.spec.js
 * Output:  /tmp/screenshots/*.png
 */
const { test } = require("@playwright/test");
const { pageUrl } = require("./helpers/config");
const fs = require("fs");

const SCREENSHOT_DIR = "/tmp/screenshots";

// Realistic captain terminal output — looks like a Claude captain managing workers
const TERMINAL_CONTENT = `╭────────────────────────────────────────────────╮
│ Claude Code — Captain                          │
╰────────────────────────────────────────────────╯

> Got it. I'll break this into two parallel tasks and dispatch workers.

⏺ Dispatching worker 1 → auth-service / window 1
  Task: Refactor JWT validation module + add refresh token rotation

⏺ Dispatching worker 2 → auth-service / window 2
  Task: Write integration tests for the auth endpoints

⏺ Using tool: create_session (auth-service)
  ✓ Session created

⏺ Using tool: send_command (auth-service, window 1)
  Command: "Refactor src/auth/jwt.ts — add refresh token rotation…"
  ✓ Sent to worker 1

⏺ Using tool: send_command (auth-service, window 2)
  Command: "Write integration tests for POST /auth/login, …"
  ✓ Sent to worker 2

> Both workers are running. Worker 1 is refactoring the JWT module
  and adding refresh token rotation. Worker 2 is writing integration
  tests for the auth endpoints. I'll check on their progress.

⏺ Using tool: read_output (auth-service, window 1)
  Worker 1: Editing src/auth/jwt.ts — adding rotateRefreshToken()

⏺ Using tool: read_output (auth-service, window 2)
  Worker 2: Created tests/auth.integration.test.ts — 4/7 tests written

> Both workers are making good progress. Worker 1 is about halfway
  through the JWT refactor, and worker 2 has written 4 of 7 tests.

`;

const SUMMARY_TEXT =
  "Two workers dispatched for the auth service refactor. First worker is handling JWT validation and refresh token rotation. Second is writing integration tests for the auth endpoints. Both are making good progress.";

const TRANSCRIPTION_TEXT = "How are the workers doing on the auth service?";

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

  test("capture all three tabs", async ({ page }) => {
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

    // ── Terminal Tab ──────────────────────────────────────────
    // Simulate the "connected" message
    await page.evaluate(
      ({ terminal, summary, transcription }) => {
        // Set connected status
        const statusEl = document.getElementById("status");
        statusEl.textContent = "claude";
        statusEl.className = "connected";

        // Populate terminal
        document.getElementById("terminal").textContent = terminal;

        // Set summary
        document.getElementById("summary").textContent = summary;

        // Set transcription
        const transcriptionEl = document.getElementById("transcription");
        transcriptionEl.textContent = transcription;
        transcriptionEl.className = "";

        // Set captain select to claude
        const sel = document.getElementById("captain-tool-select");
        sel.value = "claude";
        sel.classList.add("claude-selected");

        // Scroll terminal to bottom
        const term = document.getElementById("terminal");
        term.scrollTop = term.scrollHeight;
      },
      {
        terminal: TERMINAL_CONTENT,
        summary: SUMMARY_TEXT,
        transcription: TRANSCRIPTION_TEXT,
      }
    );

    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/terminal-tab.png`,
      type: "png",
    });

    // ── Status Tab ───────────────────────────────────────────
    await page.click('[data-tab="status"]');
    await page.waitForTimeout(100);

    await page.evaluate(
      ({ panes }) => {
        document.getElementById("status-time").textContent = "\u25cf LIVE";
        document.getElementById("status-time").className = "live-indicator";

        const panesEl = document.getElementById("status-panes");
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
      path: `${SCREENSHOT_DIR}/status-tab.png`,
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
