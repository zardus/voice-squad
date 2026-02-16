// @ts-check
/**
 * Docker-in-Docker smoke test — verify that `docker` works inside
 * the workspace container. Workers rely on DinD for builds and
 * container tasks; this catches regressions early.
 *
 * Commands run via the workspace tmux session (the test-runner is a
 * separate container without access to the workspace's Docker daemon).
 */
const { test, expect } = require("@playwright/test");
const { workspaceExec } = require("./helpers/tmux");

/** Run a command in the workspace tmux pane and capture output. */
function workspaceRun(cmd, { timeout = 30000 } = {}) {
  // Use send-keys + capture-pane via a dedicated window to avoid
  // colliding with other sessions. We create a window, send the command,
  // wait, then capture.
  const win = "dind-test";
  try { workspaceExec(`kill-window -t workspace:${win} 2>/dev/null || true`); } catch {}
  workspaceExec(`new-window -t workspace -n ${win}`);
  workspaceExec(`send-keys -t workspace:${win} '${cmd}; echo __DIND_DONE__' Enter`);

  // Poll capture-pane until we see the sentinel
  const deadline = Date.now() + timeout;
  let output = "";
  while (Date.now() < deadline) {
    output = workspaceExec(`capture-pane -t workspace:${win} -p -S -200`, { timeout: 5000 });
    if (output.includes("__DIND_DONE__")) break;
    try { workspaceExec("run-shell 'sleep 2'", { timeout: 5000 }); } catch {}
  }
  try { workspaceExec(`kill-window -t workspace:${win}`); } catch {}
  return output;
}

test.describe("Docker-in-Docker", () => {
  test("dockerd is running", () => {
    test.setTimeout(60000);
    const out = workspaceRun("sudo docker info", { timeout: 45000 });
    expect(out).toContain("Server Version");
  });

  test("docker run hello-world succeeds", () => {
    test.setTimeout(120000);
    const out = workspaceRun("sudo docker run --rm hello-world", { timeout: 90000 });
    expect(out).toContain("Hello from Docker!");
  });

  test("docker build works", () => {
    test.setTimeout(120000);
    const out = workspaceRun(
      "printf 'FROM alpine\\nRUN echo dind-ok' | sudo docker build -q -",
      { timeout: 90000 }
    );
    expect(out).toMatch(/sha256:[0-9a-f]+/);
  });
});
