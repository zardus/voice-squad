// @ts-check
/**
 * Integration tests — send commands to the captain and verify behavior.
 *
 * These tests interact with the live captain agent and are opt-in:
 *   TEST_INTEGRATION=1 npx playwright test integration.spec.js
 *
 * They are skipped by default to avoid disrupting a running captain.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const fs = require("fs");
const { TOKEN, pageUrl } = require("./helpers/config");

const INTEGRATION = process.env.TEST_INTEGRATION === "1";
const TEST_FILE = "/home/ubuntu/test-hello-e2e.txt";

test.describe("Integration", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
    // Ensure captain:0 has a clean bash shell — earlier tests (e.g. restart-captain)
    // may have started a real captain agent if API keys are present.
    try { execSync("tmux respawn-pane -k -t captain:0 bash", { timeout: 5000 }); } catch {}
  });

  test("send text command and observe tmux_snapshot change", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

    // Capture the initial terminal content
    const initialContent = await page.locator("#terminal").textContent();

    // Send a harmless command and produce enough output that UI-side trimming
    // (hiding the bottom prompt area) won't clip it entirely.
    await page.fill("#text-input", 'for i in $(seq 1 12); do echo "hello from test suite $i"; done');
    await page.click("#send-btn");

    // Wait for terminal content to change (tmux_snapshot comes every 1s)
    await page.waitForFunction(
      (initial) => {
        const current = document.getElementById("terminal").textContent;
        return current !== initial && current.length > 0;
      },
      initialContent,
      { timeout: 10000 },
    );

    const newContent = await page.locator("#terminal").textContent();
    expect(newContent).not.toBe(initialContent);
  });

  test("command sent via UI creates a file in the captain pane", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(30000);

    // Clean up any leftover test file
    try { fs.unlinkSync(TEST_FILE); } catch {}

    // Other tests (notably /api/restart-captain) may leave captain:0 running something other than a shell.
    // Force a predictable bash pane so the redirection command works deterministically.
    try {
      execSync("tmux respawn-pane -k -t captain:0 bash", { timeout: 5000 });
    } catch {}

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

    // Send a shell command via the UI text input.
    // The captain pane runs a shell, so this exercises the full pipeline:
    // UI -> WebSocket text_command -> tmux send-keys -> shell execution -> file created.
    await page.fill(
      "#text-input",
      `echo "hello from e2e test" > ${TEST_FILE}`,
    );
    await page.click("#send-btn");

    // Poll for file creation (tmux send-keys + shell execution)
    let found = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const content = fs.readFileSync(TEST_FILE, "utf8");
        if (content.includes("hello from e2e test")) {
          found = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(found).toBe(true);

    // Verify file contents
    const content = fs.readFileSync(TEST_FILE, "utf8");
    expect(content).toContain("hello from e2e test");

    // Clean up
    try { fs.unlinkSync(TEST_FILE); } catch {}
  });

  test("interrupt stops captain processing", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 5000 });

    // Send interrupt via API
    const resp = await fetch(`http://localhost:3000/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);

    // Verify captain pane is still alive after interrupt
    const paneContent = execSync("tmux capture-pane -t captain:0 -p -S -10", {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(paneContent).toBeTruthy();
  });

  test("WebSocket receives tmux_snapshot within 3 seconds", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(10000);

    await page.goto(pageUrl());

    const snapshotTime = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "tmux_snapshot") {
              ws.close();
              resolve(Date.now() - start);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("no snapshot in 3s")), 3000);
      });
    }, { token: TOKEN });

    expect(snapshotTime).toBeLessThan(3000);
  });
});
