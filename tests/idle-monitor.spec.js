// @ts-check
/**
 * Idle monitor tests — verify pane-monitor.sh detects idle worker panes.
 *
 * In the per-project architecture, worker panes live in project sockets.
 * This test creates a temporary project socket directory and tmux session
 * to simulate a project container.
 */
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const path = require("path");
const { TOKEN } = require("./helpers/config");

const MONITOR_LOG = "/tmp/pane-monitor.log";
const OVERSEER_SOCKET = "/run/squad-sockets/overseer-tmux/default";
const PROJECTS_DIR = "/run/squad-sockets/projects";
const TEST_PROJECT = "idle-test-project";
const TEST_PROJECT_SOCKET_DIR = path.join(PROJECTS_DIR, TEST_PROJECT);
const TEST_PROJECT_SOCKET = path.join(TEST_PROJECT_SOCKET_DIR, "default");
const ACTIVE_PROJECT = "active-test-project";
const ACTIVE_PROJECT_SOCKET_DIR = path.join(PROJECTS_DIR, ACTIVE_PROJECT);
const ACTIVE_PROJECT_SOCKET = path.join(ACTIVE_PROJECT_SOCKET_DIR, "default");
let monitorPid = null;

function overseerExec(args, opts = {}) {
  return execSync(`tmux -S ${OVERSEER_SOCKET} ${args}`, {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

test.describe("Idle monitor", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");

    // Ensure tmux sockets are usable from the test-runner container.
    execSync(`tmux -S ${OVERSEER_SOCKET} has-session -t overseer`, { encoding: "utf8", timeout: 5000 });

    // Create test project socket directory and tmux session
    execSync(`mkdir -p ${TEST_PROJECT_SOCKET_DIR}`, { encoding: "utf8" });
    execSync(`tmux -S ${TEST_PROJECT_SOCKET} new-session -d -s agents -c /home/ubuntu`, { encoding: "utf8", timeout: 5000 });

    // Keep overseer pane in shell mode for predictable monitoring behavior.
    try {
      overseerExec("respawn-pane -k -t overseer:0 bash");
    } catch {}

    // Start a dedicated monitor process for this spec with long heartbeat interval.
    execSync(`rm -f ${MONITOR_LOG}`, { encoding: "utf8", timeout: 5000 });
    const monitor = spawn("/opt/squad/pane-monitor.sh", {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        OVERSEER_TMUX_SOCKET: OVERSEER_SOCKET,
        PROJECTS_SOCKETS_DIR: PROJECTS_DIR,
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
    // Clean up tmux sessions
    try {
      execSync(`tmux -S ${TEST_PROJECT_SOCKET} kill-server`, { encoding: "utf8", timeout: 5000 });
    } catch {}
    try {
      execSync(`tmux -S ${ACTIVE_PROJECT_SOCKET} kill-server`, { encoding: "utf8", timeout: 5000 });
    } catch {}
    // Clean up socket dirs
    try {
      execSync(`rm -rf ${TEST_PROJECT_SOCKET_DIR} ${ACTIVE_PROJECT_SOCKET_DIR}`, { encoding: "utf8", timeout: 5000 });
    } catch {}
    if (monitorPid) {
      try {
        process.kill(monitorPid, "SIGTERM");
      } catch {}
    }
  });

  test("detects idle worker pane and logs IDLE ALERT", async () => {
    test.setTimeout(120000);

    // Create a window in the agents session simulating a worker
    execSync(`tmux -S ${TEST_PROJECT_SOCKET} send-keys -t agents:0 'echo worker starting' Enter`, {
      encoding: "utf8",
      timeout: 5000,
    });

    const deadline = Date.now() + 100000;
    let logText = "";
    while (Date.now() < deadline) {
      try {
        logText = fs.readFileSync(MONITOR_LOG, "utf8");
      } catch {
        logText = "";
      }

      if (logText.includes("IDLE ALERT") && logText.includes(`${TEST_PROJECT}/agents:0`)) {
        break;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    expect(logText).toContain("IDLE ALERT");
    expect(logText).toContain(`${TEST_PROJECT}/agents:0`);
  });

  test("does NOT alert for a pane with continuously changing content", async () => {
    test.setTimeout(90000);

    // Create the active project session fresh so it hasn't been idle
    execSync(`mkdir -p ${ACTIVE_PROJECT_SOCKET_DIR}`, { encoding: "utf8" });
    execSync(`tmux -S ${ACTIVE_PROJECT_SOCKET} new-session -d -s agents -c /home/ubuntu`, { encoding: "utf8", timeout: 5000 });

    // Start continuously changing content immediately
    execSync(`tmux -S ${ACTIVE_PROJECT_SOCKET} send-keys -t agents:0 'while true; do date; sleep 1; done' Enter`, {
      encoding: "utf8",
      timeout: 5000,
    });

    await new Promise((r) => setTimeout(r, 50000));

    let logText = "";
    try {
      logText = fs.readFileSync(MONITOR_LOG, "utf8");
    } catch {}

    const activeAlerts = logText
      .split("\n")
      .filter((l) => l.includes("IDLE ALERT") && l.includes(`${ACTIVE_PROJECT}/agents:0`));
    expect(activeAlerts).toHaveLength(0);
  });
});
