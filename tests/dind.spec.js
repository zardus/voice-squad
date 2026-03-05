// @ts-check
/**
 * Docker CLI smoke test — verify that the captain container has access
 * to the Docker socket and can run basic docker commands.
 *
 * In the per-project architecture, the captain manages sibling containers
 * on the host dockerd via the mounted Docker socket.
 */
const { test, expect } = require("@playwright/test");
const { captainExec } = require("./helpers/tmux");

/** Run a command in the captain tmux pane and capture output. */
function captainRun(cmd, { timeout = 30000 } = {}) {
  const win = "docker-test";
  try { captainExec(`kill-window -t captain:${win} 2>/dev/null || true`); } catch {}
  captainExec(`new-window -t captain -n ${win}`);
  captainExec(`send-keys -t captain:${win} "${cmd}; echo __DOCKER_DONE__" Enter`);

  const deadline = Date.now() + timeout;
  let output = "";
  while (Date.now() < deadline) {
    output = captainExec(`capture-pane -t captain:${win} -p -S -200`, { timeout: 5000 });
    const matches = output.split("\n").filter((l) => l.trim() === "__DOCKER_DONE__");
    if (matches.length > 0) break;
    try { captainExec("run-shell 'sleep 2'", { timeout: 5000 }); } catch {}
  }
  try { captainExec(`kill-window -t captain:${win}`); } catch {}
  return output;
}

test.describe("Docker CLI access", () => {
  test("docker info works from captain", () => {
    test.setTimeout(60000);
    const out = captainRun("docker info", { timeout: 45000 });
    expect(out).toContain("Server Version");
  });

  test("docker ps works from captain", () => {
    test.setTimeout(30000);
    const out = captainRun("docker ps --format '{{.Names}}'", { timeout: 20000 });
    expect(out).toContain("__DOCKER_DONE__");
  });
});
