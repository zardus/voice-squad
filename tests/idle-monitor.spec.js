// @ts-check
/**
 * Idle monitor tests — verify pane-monitor.sh detects idle worker panes
 * and sends IDLE ALERT messages to the captain pane.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN } = require("./helpers/config");
const { captainExec, workspaceExec } = require("./helpers/tmux");

const WORKER_SESSION = "idle-test-worker";
const ACTIVE_SESSION = "active-test-worker";
const RESUME_SESSION = "idle-resume-worker";

function getIdleAlerts(output, sessionName) {
  return output
    .split("\n")
    .filter((line) => line.includes("IDLE ALERT") && line.includes(sessionName));
}

async function waitForIdleAlert(sessionName, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let captainOutput = "";

  while (Date.now() < deadline) {
    try {
      captainOutput = captainExec("capture-pane -t captain:0 -p -S -300");
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (getIdleAlerts(captainOutput, sessionName).length > 0) {
      return captainOutput;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  return captainOutput;
}

test.describe("Idle monitor", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
    // Earlier tests (e.g. api.spec restart-captain) may leave captain:0 running
    // Claude Code instead of a clean shell. Respawn with bash so our tmux
    // send-keys / capture-pane assertions work against a plain prompt.
    try { captainExec("respawn-pane -k -t captain:0 bash"); } catch {}
  });

  test.afterAll(() => {
    for (const s of [WORKER_SESSION, ACTIVE_SESSION, RESUME_SESSION]) {
      try { workspaceExec(`kill-session -t ${s}`); } catch {}
    }
  });

  test("detects idle worker pane and does NOT repeat alerts", async () => {
    test.setTimeout(150000);

    // Create the worker tmux session on the WORKSPACE server FIRST
    // so the monitor can discover the pane in its initial state.
    workspaceExec(`new-session -d -s ${WORKER_SESSION} -c /home/ubuntu`);

    // Wait for monitor discovery + initial hash tracking.
    await new Promise((r) => setTimeout(r, 3000));

    // Generate activity so has_had_activity=1 for this pane.
    workspaceExec(`send-keys -t ${WORKER_SESSION} 'echo worker starting' Enter`);
    await new Promise((r) => setTimeout(r, 3000));

    // Clear captain pane so we can count fresh alerts.
    captainExec("send-keys -t captain:0 'clear' Enter");

    const firstOutput = await waitForIdleAlert(WORKER_SESSION);
    const firstCount = getIdleAlerts(firstOutput, WORKER_SESSION).length;
    expect(firstCount).toBeGreaterThan(0);

    // With unchanged pane content, no additional alerts should appear.
    await new Promise((r) => setTimeout(r, 50000));
    const followupOutput = captainExec("capture-pane -t captain:0 -p -S -500");
    const followupCount = getIdleAlerts(followupOutput, WORKER_SESSION).length;
    expect(followupCount).toBe(firstCount);
  });

  test("alerts again after activity resumes and a new idle period starts", async () => {
    test.setTimeout(180000);

    workspaceExec(`new-session -d -s ${RESUME_SESSION} -c /home/ubuntu`);
    await new Promise((r) => setTimeout(r, 3000));

    workspaceExec(`send-keys -t ${RESUME_SESSION} 'echo first activity' Enter`);
    await new Promise((r) => setTimeout(r, 3000));

    captainExec("send-keys -t captain:0 'clear' Enter");

    const firstOutput = await waitForIdleAlert(RESUME_SESSION);
    const firstCount = getIdleAlerts(firstOutput, RESUME_SESSION).length;
    expect(firstCount).toBeGreaterThan(0);

    // Activity resumes, then pane idles again.
    workspaceExec(`send-keys -t ${RESUME_SESSION} 'echo resumed activity' Enter`);
    await new Promise((r) => setTimeout(r, 3000));

    const deadline = Date.now() + 90000;
    let captainOutput = "";
    while (Date.now() < deadline) {
      try {
        captainOutput = captainExec("capture-pane -t captain:0 -p -S -500");
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (getIdleAlerts(captainOutput, RESUME_SESSION).length > firstCount) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    expect(getIdleAlerts(captainOutput, RESUME_SESSION).length).toBeGreaterThan(firstCount);
  });

  test("does NOT alert for a pane with continuously changing content", async () => {
    test.setTimeout(90000);

    // This simulates a pane actively producing output.
    workspaceExec(`new-session -d -s ${ACTIVE_SESSION} -c /home/ubuntu`);

    // Wait for the monitor to discover and begin tracking this pane.
    await new Promise((r) => setTimeout(r, 3000));

    // Generate initial activity so has_had_activity=1.
    workspaceExec(`send-keys -t ${ACTIVE_SESSION} 'echo active worker' Enter`);
    await new Promise((r) => setTimeout(r, 2000));

    // Start continuously changing output.
    workspaceExec(
      `send-keys -t ${ACTIVE_SESSION} 'while true; do date; sleep 1; done' Enter`
    );

    captainExec("send-keys -t captain:0 'clear' Enter");
    await new Promise((r) => setTimeout(r, 1000));

    await new Promise((r) => setTimeout(r, 50000));

    let captainOutput = "";
    try {
      captainOutput = captainExec("capture-pane -t captain:0 -p -S -200");
    } catch {}

    expect(getIdleAlerts(captainOutput, ACTIVE_SESSION)).toHaveLength(0);
  });
});
