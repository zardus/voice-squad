// @ts-check
/**
 * Idle monitor tests — verify pane-monitor.sh detects idle worker panes.
 */
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const { TOKEN } = require("./helpers/config");

const WORKER_SESSION = "idle-test-worker";
const ACTIVE_SESSION = "active-test-worker";
const MONITOR_LOG = "/tmp/pane-monitor.log";
const CAPTAIN_SOCKET = "/run/captain-tmux/default";
const WORKSPACE_SOCKET = "/run/workspace-tmux/default";
let monitorPid = null;

function captainExec(args, opts = {}) {
  return execSync(`tmux -S ${CAPTAIN_SOCKET} ${args}`, {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

function workspaceExec(args, opts = {}) {
  return execSync(`tmux -S ${WORKSPACE_SOCKET} ${args}`, {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

test.describe("Idle monitor", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");

    // Ensure tmux sockets are usable from the test-runner container.
    execSync(`tmux -S ${CAPTAIN_SOCKET} has-session -t captain`, { encoding: "utf8", timeout: 5000 });
    execSync(`tmux -S ${WORKSPACE_SOCKET} has-session -t workspace`, { encoding: "utf8", timeout: 5000 });

    // Keep detached worker sessions alive during tests.
    workspaceExec("set-option -g destroy-unattached off");
    workspaceExec("set-option -g exit-empty off");
    workspaceExec("set-option -g exit-unattached off");

    // Keep captain pane in shell mode for predictable monitoring behavior.
    try {
      captainExec("respawn-pane -k -t captain:0 bash");
    } catch {}

    // Start a dedicated monitor process for this spec with long heartbeat interval.
    try {
      execSync("pkill -f 'pane-monitor-test'", { encoding: "utf8", timeout: 5000 });
    } catch {}
    execSync(`rm -f ${MONITOR_LOG}`, { encoding: "utf8", timeout: 5000 });
    const monitor = spawn("/opt/squad/pane-monitor.sh", {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        CAPTAIN_TMUX_SOCKET: CAPTAIN_SOCKET,
        WORKSPACE_TMUX_SOCKET: WORKSPACE_SOCKET,
        HEARTBEAT_INTERVAL_SECONDS: "900",
      },
    });
    monitorPid = monitor.pid;
    monitor.unref();

    // Ensure the monitor started and wrote its startup log line.
    const startDeadline = Date.now() + 10000;
    let started = false;
    while (Date.now() < startDeadline) {
      try {
        const logText = fs.readFileSync(MONITOR_LOG, "utf8");
        if (logText.includes("Pane monitor started")) {
          started = true;
          break;
        }
      } catch {}
      execSync("sleep 1", { encoding: "utf8", timeout: 2000 });
    }
    expect(started).toBe(true);
  });

  test.afterAll(() => {
    try {
      workspaceExec(`kill-session -t ${WORKER_SESSION}`);
    } catch {}
    try {
      workspaceExec(`kill-session -t ${ACTIVE_SESSION}`);
    } catch {}
    try {
      execSync("pkill -f 'pane-monitor-test'", { encoding: "utf8", timeout: 5000 });
    } catch {}
    if (monitorPid) {
      try {
        process.kill(monitorPid, "SIGTERM");
      } catch {}
    }
  });

  test("starts pane monitor process and writes startup log", async () => {
    test.setTimeout(30000);

    await new Promise((r) => setTimeout(r, 2000));
    let logText = "";
    try {
      logText = fs.readFileSync(MONITOR_LOG, "utf8");
    } catch {}

    expect(logText).toContain("Pane monitor started");
  });

  test("does NOT alert for a pane with continuously changing content", async () => {
    test.setTimeout(90000);

    workspaceExec(`new-session -d -s ${ACTIVE_SESSION} -c /home/ubuntu`);
    await new Promise((r) => setTimeout(r, 3000));

    workspaceExec(`send-keys -t ${ACTIVE_SESSION} 'echo active worker' Enter`);
    await new Promise((r) => setTimeout(r, 2000));

    workspaceExec(`send-keys -t ${ACTIVE_SESSION} 'while true; do date; sleep 1; done' Enter`);

    await new Promise((r) => setTimeout(r, 50000));

    let logText = "";
    try {
      logText = fs.readFileSync(MONITOR_LOG, "utf8");
    } catch {}

    const activeAlerts = logText
      .split("\n")
      .filter((l) => l.includes("IDLE ALERT") && l.includes(`${ACTIVE_SESSION}:0`));
    expect(activeAlerts).toHaveLength(0);
  });
});
