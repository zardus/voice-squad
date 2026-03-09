// @ts-check
/**
 * Worker dialog auto-accept tests — verify that create-worker handles
 * Claude's --dangerously-skip-permissions trust dialog automatically.
 *
 * These tests simulate Claude's trust prompt in a tmux session and verify
 * that the auto-accept logic in create-worker dismisses it correctly.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const fs = require("fs");

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", timeout: 10000, ...opts });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

test.describe("Worker dialog auto-accept", () => {
  const SOCKET = "/tmp/test-worker-dialog.sock";
  const SESSION = "agents";
  const WINDOW = "test-task";

  test.beforeEach(() => {
    try { exec(`tmux -S ${SOCKET} kill-server`); } catch {}
    exec(`tmux -S ${SOCKET} new-session -d -s ${SESSION} -n PLACEHOLDER`);
    exec(`tmux -S ${SOCKET} new-window -t ${SESSION} -n ${WINDOW}`);
  });

  test.afterEach(() => {
    try { exec(`tmux -S ${SOCKET} kill-server`); } catch {}
    try { fs.unlinkSync(SOCKET); } catch {}
  });

  test("accepts trust dialog with 'Yes, I accept' and 'Enter to confirm'", async () => {
    // Write a mock script that simulates Claude's trust dialog
    const mockScript = "/tmp/mock-trust-dialog.sh";
    fs.writeFileSync(mockScript, [
      "#!/bin/bash",
      'echo ""',
      'echo "Warning: You are about to enable dangerous skip permissions mode."',
      'echo ""',
      'echo "  1. No, take me back"',
      'echo "  2. Yes, I accept"',
      'echo ""',
      'echo "Enter to confirm"',
      'echo ""',
      "read -r INPUT",
      'echo "DIALOG_RESULT=$INPUT"',
    ].join("\n"));
    exec(`chmod +x ${mockScript}`);

    // Run the mock in the worker pane
    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" '${mockScript}' Enter`);
    await sleep(1000);

    // Verify dialog text is showing
    let pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("Yes, I accept");
    expect(pane).toContain("Enter to confirm");

    // Apply the same auto-accept logic used by create-worker
    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" 2`);
    await sleep(500);
    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" Enter`);
    await sleep(1000);

    // Verify the dialog was accepted with option 2
    pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("DIALOG_RESULT=2");
  });

  test("accepts setup/onboarding dialogs with Enter", async () => {
    const mockScript = "/tmp/mock-setup-dialog.sh";
    fs.writeFileSync(mockScript, [
      "#!/bin/bash",
      'echo "Choose the text style for Claude responses"',
      'echo ""',
      'echo "  1. Plain"',
      'echo "  2. Styled"',
      'echo ""',
      "read -r INPUT",
      'echo "SETUP_DISMISSED=true"',
    ].join("\n"));
    exec(`chmod +x ${mockScript}`);

    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" '${mockScript}' Enter`);
    await sleep(1000);

    let pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("Choose the text style");

    // Auto-accept: send Enter (same as create-worker)
    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" Enter`);
    await sleep(1000);

    pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("SETUP_DISMISSED=true");
  });

  test("accepts generic 'Enter to confirm' dialogs", async () => {
    const mockScript = "/tmp/mock-confirm-dialog.sh";
    fs.writeFileSync(mockScript, [
      "#!/bin/bash",
      'echo "Some configuration prompt"',
      'echo "Enter to confirm"',
      "read -r INPUT",
      'echo "CONFIRM_DISMISSED=true"',
    ].join("\n"));
    exec(`chmod +x ${mockScript}`);

    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" '${mockScript}' Enter`);
    await sleep(1000);

    let pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("Enter to confirm");

    exec(`tmux -S ${SOCKET} send-keys -t "${SESSION}:${WINDOW}" Enter`);
    await sleep(1000);

    pane = stripAnsi(exec(`tmux -S ${SOCKET} capture-pane -t "${SESSION}:${WINDOW}" -p -S -30`));
    expect(pane).toContain("CONFIRM_DISMISSED=true");
  });

  test("create-worker script contains dialog auto-accept logic", () => {
    const script = fs.readFileSync("/opt/squad/captain/create-worker", "utf8");

    // Must detect trust dialog
    expect(script).toContain("Yes, I accept");
    expect(script).toContain("Enter to confirm");

    // Must send option 2 to accept trust
    expect(script).toMatch(/send-keys.*2/);

    // Must handle setup dialogs
    expect(script).toContain("Choose the text style");

    // Must only apply to claude workers (not codex)
    expect(script).toContain('if [ "$TOOL" = "claude" ]');
  });
});
