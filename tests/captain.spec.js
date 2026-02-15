// @ts-check
/**
 * Captain E2E tests — start a real captain agent and exercise the full pipeline.
 *
 * These tests require real API keys and are opt-in:
 *   TEST_CAPTAIN=1 ./test.sh captain.spec.js
 *
 * API keys should be set as env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY) or
 * written to home/env (sourced automatically by test.sh).
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const fs = require("fs");
const { BASE_URL, TOKEN, pageUrl } = require("./helpers/config");

const CAPTAIN = process.env.TEST_CAPTAIN === "1";
const TEST_FILE = "/home/ubuntu/captain-test.txt";

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test.describe("Captain E2E", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("captain processes a task and spawns a worker", async () => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run captain tests");
    test.setTimeout(10 * 60 * 1000); // 10 minutes

    // Clean up any leftover test file
    try { fs.unlinkSync(TEST_FILE); } catch {}

    // --- Pre-configure Claude Code ---
    // Skip first-run onboarding
    fs.mkdirSync("/home/ubuntu/.claude", { recursive: true });
    fs.writeFileSync("/home/ubuntu/.claude.json", JSON.stringify({
      hasCompletedOnboarding: true,
    }));

    // Set up API key auth via apiKeyHelper (most reliable headless method)
    let apiKey = "";
    try {
      apiKey = execSync("bash -c '. /home/ubuntu/env && echo $ANTHROPIC_API_KEY'", {
        encoding: "utf8", timeout: 5000,
      }).trim();
    } catch {}
    expect(apiKey).toBeTruthy();

    const helperPath = "/home/ubuntu/.claude/api-key-helper.sh";
    fs.writeFileSync(helperPath, `#!/bin/sh\necho '${apiKey}'\n`);
    execSync(`chmod +x ${helperPath}`, { timeout: 5000 });
    fs.writeFileSync("/home/ubuntu/.claude/settings.json", JSON.stringify({
      env: { ANTHROPIC_API_KEY: apiKey },
      apiKeyHelper: helperPath,
    }));

    // Export API key in .bashrc and tmux env so workers inherit it
    fs.appendFileSync("/home/ubuntu/.bashrc",
      `\nexport ANTHROPIC_API_KEY='${apiKey}'\n`
    );
    execSync(`tmux set-environment -t captain ANTHROPIC_API_KEY '${apiKey}'`, { timeout: 5000 });

    // --- Start Claude ---
    console.log("[captain-test] Starting claude captain...");
    try {
      execSync("tmux send-keys -t captain:0 C-c", { timeout: 5000 });
      execSync("tmux send-keys -t captain:0 C-c", { timeout: 5000 });
    } catch {}
    await sleep(1000);

    execSync(
      'tmux send-keys -t captain:0 "cd /home/ubuntu/captain && source ~/.bashrc && claude --dangerously-skip-permissions" Enter',
      { timeout: 10000 }
    );

    // --- Wait for Claude to be ready ---
    console.log("[captain-test] Waiting for claude to be ready...");
    let ready = false;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      try {
        const shellPid = execSync("tmux list-panes -t captain:0 -F '#{pane_pid}'", {
          encoding: "utf8", timeout: 5000,
        }).trim();
        const childPid = execSync(`ps -o pid= --ppid ${shellPid} 2>/dev/null | head -1`, {
          encoding: "utf8", timeout: 5000,
        }).trim();

        if (!childPid) {
          // Claude may have exited at a trust prompt — restart
          const raw = execSync("tmux capture-pane -t captain:0 -p -S -50", {
            encoding: "utf8", timeout: 5000,
          });
          if (stripAnsi(raw).includes("Yes, I accept")) {
            execSync("tmux send-keys -t captain:0 Enter", { timeout: 5000 });
            await sleep(1000);
            execSync(
              'tmux send-keys -t captain:0 "claude --dangerously-skip-permissions" Enter',
              { timeout: 10000 }
            );
          }
          continue;
        }

        const raw = execSync("tmux capture-pane -t captain:0 -p", {
          encoding: "utf8", timeout: 5000,
        });
        const cleaned = stripAnsi(raw);

        // Handle setup dialogs
        if (cleaned.includes("Choose the text style") ||
            cleaned.includes("Let's get started")) {
          execSync("tmux send-keys -t captain:0 Enter", { timeout: 5000 });
          await sleep(1000);
          continue;
        }

        // Trust dialog — select "Yes, I accept" (option 2)
        if (cleaned.includes("Yes, I accept") && cleaned.includes("Enter to confirm")) {
          execSync("tmux send-keys -t captain:0 2", { timeout: 5000 });
          await sleep(500);
          execSync("tmux send-keys -t captain:0 Enter", { timeout: 5000 });
          await sleep(3000);
          continue;
        }

        // Other "Enter to confirm" dialogs — accept default
        if (cleaned.includes("Enter to confirm")) {
          execSync("tmux send-keys -t captain:0 Enter", { timeout: 5000 });
          await sleep(2000);
          continue;
        }

        // Claude is ready when showing workspace info without pending dialogs
        if (cleaned.includes("/home/ubuntu") ||
            cleaned.includes("What can I help") ||
            cleaned.includes("Type your") ||
            cleaned.includes("help you")) {
          if (!cleaned.includes("Enter to confirm")) {
            ready = true;
            console.log("[captain-test] Claude ready.");
            break;
          }
        }

        if (i > 0 && i % 15 === 0) {
          const lines = cleaned.split("\n").filter((l) => l.trim());
          const tail = lines.slice(-2).map((l) => l.slice(-80));
          console.log(`[captain-test] Waiting (${i * 2}s)... ${JSON.stringify(tail)}`);
        }
      } catch {}
    }
    expect(ready).toBe(true);
    await sleep(5000);

    // --- Send task ---
    const task = `Create a file at ${TEST_FILE} with the text 'hello from captain test'`;
    console.log(`[captain-test] Sending task: ${task}`);
    execSync(`tmux send-keys -t captain:0 -l "${task.replace(/"/g, '\\"')}"`, { timeout: 5000 });
    await sleep(500);
    execSync("tmux send-keys -t captain:0 Enter", { timeout: 5000 });

    // --- Poll for file creation (up to 5 minutes) ---
    console.log("[captain-test] Polling for test file...");
    let fileCreated = false;
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      if (fs.existsSync(TEST_FILE)) {
        fileCreated = true;
        break;
      }
      if (i > 0 && i % 15 === 0) {
        try {
          const raw = execSync("tmux capture-pane -t captain:0 -p", {
            encoding: "utf8", timeout: 5000,
          });
          const lines = stripAnsi(raw).split("\n").filter((l) => l.trim());
          const tail = lines.slice(-2).map((l) => l.slice(-80));
          console.log(`[captain-test] Polling (${i * 2}s)... ${JSON.stringify(tail)}`);
        } catch {}
      }
    }
    expect(fileCreated).toBe(true);

    // Verify file contents
    const contents = fs.readFileSync(TEST_FILE, "utf8");
    expect(contents).toContain("hello from captain test");
    console.log(`[captain-test] File created: ${contents.trim()}`);

    // Verify worker was spawned (should have >1 tmux window)
    const windowList = execSync("tmux list-windows -t captain", {
      encoding: "utf8", timeout: 5000,
    });
    const windowCount = windowList.trim().split("\n").length;
    console.log(`[captain-test] tmux windows: ${windowCount}`);
    expect(windowCount).toBeGreaterThan(1);

    // Cleanup
    try {
      execSync("tmux send-keys -t captain:0 C-c", { timeout: 5000 });
      execSync("tmux send-keys -t captain:0 C-c", { timeout: 5000 });
    } catch {}
    try { fs.unlinkSync(TEST_FILE); } catch {}
  });

  test("voice round-trip: /api/speak produces TTS audio", async ({ page }) => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run captain tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await expect(page.locator("#status")).toHaveClass(/connected/, { timeout: 10000 });
    await sleep(1000);

    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TOKEN,
        text: "Hello from voice round-trip test",
      }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.clients).toBeGreaterThanOrEqual(1);
    console.log(`[captain-test] /api/speak: sent to ${json.clients} client(s)`);
  });

  test("summary API returns Haiku status overview", async () => {
    test.skip(!CAPTAIN, "Set TEST_CAPTAIN=1 to run captain tests");
    test.setTimeout(30000);

    const resp = await fetch(`${BASE_URL}/api/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("summary");
    expect(typeof json.summary).toBe("string");
    expect(json.summary.length).toBeGreaterThan(0);
    console.log(`[captain-test] /api/summary: ${json.summary.slice(0, 120)}...`);
  });
});
