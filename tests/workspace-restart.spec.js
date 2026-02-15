// @ts-check
/**
 * Workspace restart resilience — verify the voice server recovers
 * and lists all tmux terminals after the workspace (tmux) is restarted.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const { BASE_URL, TOKEN, pageUrl } = require("./helpers/config");

const WORKER_SESSION = "test-project";

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
 * Returns a cleanup function to deactivate and close the socket.
 */
function activateStatusDaemon(page) {
  return page.evaluate(async (params) => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:3000?token=${encodeURIComponent(params.token)}`
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
      // Keep the socket open — the page staying alive keeps it connected
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

test.describe("Workspace restart", () => {
  test.beforeAll(() => {
    if (!TOKEN)
      throw new Error(
        "Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists"
      );
  });

  test.afterAll(() => {
    // Clean up the worker session if it still exists
    try {
      execSync(`tmux kill-session -t ${WORKER_SESSION} 2>/dev/null || true`, {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch {}
  });

  test("voice server lists sessions after workspace restart", async ({ page }) => {
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

    // 2. Create an additional tmux session to simulate a worker
    execSync(
      `tmux new-session -d -s ${WORKER_SESSION} -c /home/ubuntu`,
      { encoding: "utf8", timeout: 5000 }
    );

    // 3. Wait for /api/status to include the new session
    const withWorker = await waitForStatus(
      (s) => sessionNames(s).includes(WORKER_SESSION),
      { timeoutMs: 10000 }
    );
    expect(sessionNames(withWorker)).toContain("captain");
    expect(sessionNames(withWorker)).toContain(WORKER_SESSION);

    // 4. Simulate a workspace restart: kill tmux, then recreate sessions
    execSync("tmux kill-server", { encoding: "utf8", timeout: 5000 });

    // Brief pause to let the kill propagate
    await new Promise((r) => setTimeout(r, 1000));

    // Recreate the captain session and worker session
    execSync("tmux new-session -d -s captain -c /home/ubuntu", {
      encoding: "utf8",
      timeout: 5000,
    });
    execSync(`tmux new-session -d -s ${WORKER_SESSION} -c /home/ubuntu`, {
      encoding: "utf8",
      timeout: 5000,
    });

    // 5-6. Wait for the status-daemon to pick up the recreated sessions
    const recovered = await waitForStatus(
      (s) => {
        const names = sessionNames(s);
        return names.includes("captain") && names.includes(WORKER_SESSION);
      },
      { timeoutMs: 15000 }
    );
    expect(sessionNames(recovered)).toContain("captain");
    expect(sessionNames(recovered)).toContain(WORKER_SESSION);

    // Verify sessions have windows and panes
    const captainSession = recovered.sessions.find((s) => s.name === "captain");
    expect(captainSession.windows.length).toBeGreaterThanOrEqual(1);
    expect(captainSession.windows[0].panes.length).toBeGreaterThanOrEqual(1);

    const workerSession = recovered.sessions.find(
      (s) => s.name === WORKER_SESSION
    );
    expect(workerSession.windows.length).toBeGreaterThanOrEqual(1);
    expect(workerSession.windows[0].panes.length).toBeGreaterThanOrEqual(1);

    // 7. Clean up
    await deactivateStatusDaemon(page);
    execSync(`tmux kill-session -t ${WORKER_SESSION}`, {
      encoding: "utf8",
      timeout: 5000,
    });
  });
});
