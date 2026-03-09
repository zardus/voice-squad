// @ts-check
/**
 * Docker CLI smoke test — verify that the hub container has access
 * to the Docker socket and can run basic docker commands.
 *
 * In the per-project architecture, the hub manages sibling containers
 * on the host dockerd via the mounted Docker socket. The overseer does NOT have
 * Docker access.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");

test.describe("Docker CLI access", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("hub can list projects (uses Docker internally)", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/projects?token=${encodeURIComponent(TOKEN)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("projects");
    expect(Array.isArray(json.projects)).toBe(true);
  });

  test("overseer does NOT have docker CLI", () => {
    const { overseerExec } = require("./helpers/tmux");
    const win = "docker-test";
    try { overseerExec(`kill-window -t overseer:${win} 2>/dev/null || true`); } catch {}
    overseerExec(`new-window -t overseer -n ${win}`);
    overseerExec(`send-keys -t overseer:${win} "which docker 2>&1; echo __DONE__" Enter`);

    const deadline = Date.now() + 10000;
    let output = "";
    while (Date.now() < deadline) {
      output = overseerExec(`capture-pane -t overseer:${win} -p -S -50`, { timeout: 5000 });
      if (output.includes("__DONE__")) break;
      try { overseerExec("run-shell 'sleep 1'", { timeout: 3000 }); } catch {}
    }
    try { overseerExec(`kill-window -t overseer:${win}`); } catch {}
    // docker should NOT be found in the overseer container
    expect(output).not.toContain("/usr/bin/docker");
  });
});
