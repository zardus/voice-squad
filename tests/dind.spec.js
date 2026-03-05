// @ts-check
/**
 * Docker CLI smoke test — verify that the voice-server container has access
 * to the Docker socket and can run basic docker commands.
 *
 * In the per-project architecture, the voice-server manages sibling containers
 * on the host dockerd via the mounted Docker socket. The captain does NOT have
 * Docker access.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");

test.describe("Docker CLI access", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("voice-server can list projects (uses Docker internally)", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects?token=${encodeURIComponent(TOKEN)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("projects");
    expect(Array.isArray(json.projects)).toBe(true);
  });

  test("captain does NOT have docker CLI", () => {
    const { captainExec } = require("./helpers/tmux");
    const win = "docker-test";
    try { captainExec(`kill-window -t captain:${win} 2>/dev/null || true`); } catch {}
    captainExec(`new-window -t captain -n ${win}`);
    captainExec(`send-keys -t captain:${win} "which docker 2>&1; echo __DONE__" Enter`);

    const deadline = Date.now() + 10000;
    let output = "";
    while (Date.now() < deadline) {
      output = captainExec(`capture-pane -t captain:${win} -p -S -50`, { timeout: 5000 });
      if (output.includes("__DONE__")) break;
      try { captainExec("run-shell 'sleep 1'", { timeout: 3000 }); } catch {}
    }
    try { captainExec(`kill-window -t captain:${win}`); } catch {}
    // docker should NOT be found in the captain container
    expect(output).not.toContain("/usr/bin/docker");
  });
});
