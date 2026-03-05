// @ts-check
/**
 * Project container restart resilience — verify the voice server recovers
 * and lists all tmux terminals after a project container is restarted.
 *
 * In the per-project architecture, captain runs on its own tmux server
 * and project containers have their own tmux servers under PROJECTS_SOCKETS_DIR.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const path = require("path");
const { BASE_URL, TOKEN, pageUrl } = require("./helpers/config");
const { captainExec, PROJECTS_SOCKETS_DIR } = require("./helpers/tmux");

const TEST_PROJECT = "restart-test";
const PROJECT_SOCKET_DIR = path.join(PROJECTS_SOCKETS_DIR, TEST_PROJECT);
const PROJECT_SOCKET = path.join(PROJECT_SOCKET_DIR, "default");

function projectExec(args, opts = {}) {
  return execSync(`tmux -S ${PROJECT_SOCKET} ${args}`, {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

/** Fetch /api/status and return parsed JSON. */
async function fetchStatus() {
  const resp = await fetch(
    `${BASE_URL}/api/status?token=${encodeURIComponent(TOKEN)}`
  );
  expect(resp.status).toBe(200);
  return resp.json();
}

/** Poll /api/status until a predicate is satisfied or timeout. */
async function waitForStatus(predicate, { timeoutMs = 10000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetchStatus();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForStatus timed out after ${timeoutMs}ms. Last status: ${JSON.stringify(last)}`
  );
}

function sessionNames(status) {
  return (status.sessions || []).map((s) => s.name);
}

/**
 * Open a WebSocket via the Playwright page context and send
 * status_tab_active so the voice server starts polling tmux.
 */
function activateStatusDaemon(page) {
  return page.evaluate(async (params) => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://voice-server:3000?token=${encodeURIComponent(params.token)}`
      );
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "status_tab_active" }));
      };
      ws.onmessage = (evt) => {
        if (typeof evt.data === "string") {
          const m = JSON.parse(evt.data);
          if (m.type === "connected") {
            resolve("ok");
          }
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("ws timeout")), 10000);
      window.__testStatusWs = ws;
    });
  }, { token: TOKEN });
}

function deactivateStatusDaemon(page) {
  return page.evaluate(() => {
    if (window.__testStatusWs) {
      window.__testStatusWs.send(JSON.stringify({ type: "status_tab_inactive" }));
      window.__testStatusWs.close();
      window.__testStatusWs = null;
    }
  }).catch(() => {});
}

test.describe("Project container restart", () => {
  test.beforeAll(() => {
    if (!TOKEN)
      throw new Error(
        "Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists"
      );

    // Create the project socket dir and tmux session
    execSync(`mkdir -p ${PROJECT_SOCKET_DIR}`, { encoding: "utf8" });
  });

  test.afterAll(() => {
    try {
      execSync(`tmux -S ${PROJECT_SOCKET} kill-server`, { encoding: "utf8", timeout: 5000 });
    } catch {}
    try {
      execSync(`rm -rf ${PROJECT_SOCKET_DIR}`, { encoding: "utf8", timeout: 5000 });
    } catch {}
  });

  test("voice server lists sessions after project container restart", async ({ page }) => {
    // Load the PWA page so we have a browser context for WebSocket
    await page.goto(pageUrl());

    // Activate the status daemon via WebSocket
    await activateStatusDaemon(page);

    // 1. Verify voice server is up and /api/status returns the captain session
    const initial = await waitForStatus(
      (s) => sessionNames(s).includes("captain"),
      { timeoutMs: 15000 }
    );
    expect(sessionNames(initial)).toContain("captain");

    // 2. Create a tmux session simulating a project container
    execSync(`tmux -S ${PROJECT_SOCKET} new-session -d -s agents -c /home/ubuntu`, {
      encoding: "utf8",
      timeout: 5000,
    });

    // 3. Wait for /api/status to include the project session
    const withProject = await waitForStatus(
      (s) => sessionNames(s).includes(`${TEST_PROJECT}/agents`) && sessionNames(s).includes("captain"),
      { timeoutMs: 10000 }
    );
    expect(sessionNames(withProject)).toContain("captain");
    expect(sessionNames(withProject)).toContain(`${TEST_PROJECT}/agents`);

    // 4. Simulate a project container restart: kill its tmux server
    execSync(`tmux -S ${PROJECT_SOCKET} kill-server`, { encoding: "utf8", timeout: 5000 });

    // Brief pause to let the kill propagate
    await new Promise((r) => setTimeout(r, 1000));

    // Recreate the project session
    execSync(`tmux -S ${PROJECT_SOCKET} new-session -d -s agents -c /home/ubuntu`, {
      encoding: "utf8",
      timeout: 5000,
    });

    // 5-6. Wait for the status-daemon to pick up the recreated session
    const recovered = await waitForStatus(
      (s) => {
        const names = sessionNames(s);
        return names.includes("captain") && names.includes(`${TEST_PROJECT}/agents`);
      },
      { timeoutMs: 15000 }
    );
    expect(sessionNames(recovered)).toContain("captain");
    expect(sessionNames(recovered)).toContain(`${TEST_PROJECT}/agents`);

    // Verify captain session has windows and panes
    const captainSession = recovered.sessions.find((s) => s.name === "captain");
    expect(captainSession.windows.length).toBeGreaterThanOrEqual(1);
    expect(captainSession.windows[0].panes.length).toBeGreaterThanOrEqual(1);

    const projectSession = recovered.sessions.find(
      (s) => s.name === `${TEST_PROJECT}/agents`
    );
    expect(projectSession.windows.length).toBeGreaterThanOrEqual(1);
    expect(projectSession.windows[0].panes.length).toBeGreaterThanOrEqual(1);

    // 7. Clean up
    await deactivateStatusDaemon(page);
  });
});
