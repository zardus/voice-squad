// @ts-check
/**
 * Idle monitor tests — verify pane-monitor.sh detects idle worker panes
 * and sends IDLE ALERT messages to the captain pane.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const { TOKEN } = require("./helpers/config");
const { captainExec, workspaceExec, captainTmuxCmd, workspaceTmuxCmd } = require("./helpers/tmux");

const WORKER_SESSION = "idle-test-worker";
const ACTIVE_SESSION = "active-test-worker";

test.describe("Idle monitor", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
    // Earlier tests (e.g. api.spec restart-captain) may leave captain:0 running
    // Claude Code instead of a clean shell. Respawn with bash so our tmux
    // send-keys / capture-pane assertions work against a plain prompt.
    try { captainExec("respawn-pane -k -t captain:0 bash"); } catch {}
  });

  test.afterAll(() => {
    // Cleanup: kill worker sessions and stop our pane-monitor process
    try {
      workspaceExec(`kill-session -t ${WORKER_SESSION}`);
    } catch {}
    try {
      workspaceExec(`kill-session -t ${ACTIVE_SESSION}`);
    } catch {}
    try {
      execSync("pkill -f 'pane-monitor-test'", { encoding: "utf8", timeout: 5000 });
    } catch {}
  });

  test("detects idle worker pane and sends IDLE ALERT to captain", async () => {
    test.setTimeout(120000);

    // Create the worker tmux session on the WORKSPACE server FIRST (before starting the monitor)
    // so the monitor can discover the pane in its initial state.
    workspaceExec(`new-session -d -s ${WORKER_SESSION} -c /home/ubuntu`);

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
    workspaceExec(`send-keys -t ${WORKER_SESSION} 'echo worker starting' Enter`);

    // Let the activity register (monitor needs at least one cycle to see
    // the changed hash).
    await new Promise((r) => setTimeout(r, 3000));

    // Clear the captain pane so we can detect the IDLE ALERT cleanly.
    captainExec("send-keys -t captain:0 'clear' Enter");

    // Poll for the IDLE ALERT instead of waiting a fixed time.
    // The monitor's 30-second idle counter increments once per loop iteration,
    // and each iteration takes >1s in CI due to tmux + md5sum overhead,
    // so the actual wall-clock time can be well over 35s.
    const deadline = Date.now() + 90000; // 90s generous timeout
    let captainOutput = "";
    while (Date.now() < deadline) {
      try {
        captainOutput = captainExec("capture-pane -t captain:0 -p -S -100");
      } catch {
        // Captain pane may be temporarily unavailable; retry
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (captainOutput.includes("IDLE ALERT") && captainOutput.includes(WORKER_SESSION)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    expect(captainOutput).toContain("IDLE ALERT");
    expect(captainOutput).toContain(WORKER_SESSION);
  });

  test("does NOT alert for a pane with continuously changing content", async () => {
    test.setTimeout(90000);

    // Create a worker session with a continuously ticking command.
    // This simulates a pane actively producing output (like Claude Code
    // with a ticking spinner) — the monitor should NOT fire an idle alert.
    workspaceExec(`new-session -d -s ${ACTIVE_SESSION} -c /home/ubuntu`);

    // Wait for the monitor (still running from the previous test) to
    // discover and begin tracking this pane.
    await new Promise((r) => setTimeout(r, 3000));

    // Generate initial activity so has_had_activity=1.
    workspaceExec(`send-keys -t ${ACTIVE_SESSION} 'echo active worker' Enter`);
    await new Promise((r) => setTimeout(r, 2000));

    // Start a continuously ticking command — pane content changes every second.
    workspaceExec(
      `send-keys -t ${ACTIVE_SESSION} 'while true; do date; sleep 1; done' Enter`
    );

    // Clear the captain pane so we only see alerts generated from here on.
    captainExec("send-keys -t captain:0 'clear' Enter");
    await new Promise((r) => setTimeout(r, 1000));

    // Wait well beyond the 30-second idle threshold. Each monitor loop
    // iteration takes >1s (tmux overhead), so 30 iterations ≈ 35-45s.
    // Wait 50s to be sure any false positive would have fired.
    await new Promise((r) => setTimeout(r, 50000));

    // Capture captain output and verify NO idle alert for the active session.
    let captainOutput = "";
    try {
      captainOutput = captainExec("capture-pane -t captain:0 -p -S -200");
    } catch {}

    const activeAlerts = captainOutput
      .split("\n")
      .filter((l) => l.includes("IDLE ALERT") && l.includes(ACTIVE_SESSION));
    expect(activeAlerts).toHaveLength(0);
  });
});
