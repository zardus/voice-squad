// @ts-check
/**
 * Idle monitor tests — verify pane-monitor.sh detects idle worker panes
 * and sends IDLE ALERT messages to the captain pane.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const { TOKEN } = require("./helpers/config");

const WORKER_SESSION = "idle-test-worker";

test.describe("Idle monitor", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
  });

  test.afterAll(() => {
    // Cleanup: kill worker session and stop our pane-monitor process
    try {
      execSync(`tmux kill-session -t ${WORKER_SESSION}`, { encoding: "utf8", timeout: 5000 });
    } catch {}
    try {
      execSync("pkill -f 'pane-monitor-test'", { encoding: "utf8", timeout: 5000 });
    } catch {}
  });

  test("detects idle worker pane and sends IDLE ALERT to captain", async () => {
    test.setTimeout(60000);

    // Create the worker tmux session FIRST (before starting the monitor)
    // so the monitor can discover the pane in its initial state.
    execSync(`tmux new-session -d -s ${WORKER_SESSION} -c /home/ubuntu`, {
      encoding: "utf8",
      timeout: 5000,
    });

    // Start the real pane-monitor.sh in the background.
    // Use a wrapper script name so we can target it in cleanup.
    execSync(
      "bash -c 'exec -a pane-monitor-test /opt/squad/pane-monitor.sh > /tmp/pane-monitor-test.log 2>&1 &'",
      { encoding: "utf8", timeout: 5000 }
    );

    // Wait for the monitor to discover the worker pane and record its
    // initial content hash (needs at least 2 poll cycles).
    await new Promise((r) => setTimeout(r, 3000));

    // Now generate activity — the monitor will see the content change and
    // set has_had_activity=1 for this pane.
    execSync(`tmux send-keys -t ${WORKER_SESSION} 'echo worker starting' Enter`, {
      encoding: "utf8",
      timeout: 5000,
    });

    // Let the activity register (monitor needs at least one cycle to see
    // the changed hash).
    await new Promise((r) => setTimeout(r, 3000));

    // Clear the captain pane so we can detect the IDLE ALERT cleanly.
    execSync("tmux send-keys -t captain:0 'clear' Enter", {
      encoding: "utf8",
      timeout: 5000,
    });

    // Wait for the idle threshold (30s) plus buffer for detection + send.
    // The 30s counter starts from the last content change, which was ~3s ago,
    // so we need about 30 more seconds.
    await new Promise((r) => setTimeout(r, 35000));

    // Capture the captain pane output and verify the IDLE ALERT
    const captainOutput = execSync("tmux capture-pane -t captain:0 -p -S -100", {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(captainOutput).toContain("IDLE ALERT");
    expect(captainOutput).toContain(WORKER_SESSION);
  });
});
