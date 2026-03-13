// @ts-check
/**
 * Docker-in-Docker project lifecycle test.
 *
 * Verifies the full round-trip: hub creates a sibling project container
 * via the Docker socket, the workspace entrypoint runs, the tmux socket
 * appears on the shared volume, and the project can be listed and deleted.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");
const fs = require("fs");
const { execSync } = require("child_process");

// Use a short unique name (alphanumeric + hyphens only, no dots)
const PROJECT_NAME = `dind-${Date.now().toString(36)}`;
const PROJECTS_SOCKETS_DIR =
  process.env.PROJECTS_SOCKETS_DIR || "/run/squad/tmux/projects";

test.describe("Docker-in-Docker project lifecycle", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  // Always clean up, even if a test fails mid-way
  test.afterAll(async () => {
    try {
      await fetch(
        `${BASE_URL}/api/projects/${PROJECT_NAME}?token=${encodeURIComponent(TOKEN)}`,
        { method: "DELETE" }
      );
    } catch {}
  });

  test("create project, verify socket, list, delete", async () => {
    // Project creation blocks until tmux session is ready (up to 60s)
    test.setTimeout(120000);

    // ── Create ──────────────────────────────────────────────
    const createResp = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, name: PROJECT_NAME }),
    });
    expect(createResp.status).toBe(200);
    const created = await createResp.json();
    expect(created.name).toBe(PROJECT_NAME);
    expect(created.status).toBe("running");

    // ── Verify tmux socket on shared volume ─────────────────
    const socketPath = `${PROJECTS_SOCKETS_DIR}/${PROJECT_NAME}/default`;
    expect(fs.existsSync(socketPath)).toBe(true);
    const stat = fs.statSync(socketPath);
    expect(stat.isSocket()).toBe(true);

    // Verify the agents session is reachable from the test-runner
    const sessionCheck = execSync(
      `tmux -S "${socketPath}" has-session -t agents 2>&1 && echo OK || echo FAIL`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    expect(sessionCheck).toContain("OK");

    // ── List ────────────────────────────────────────────────
    const listResp = await fetch(
      `${BASE_URL}/api/projects?token=${encodeURIComponent(TOKEN)}`
    );
    expect(listResp.status).toBe(200);
    const { projects } = await listResp.json();
    const ours = projects.find((p) => p.name === PROJECT_NAME);
    expect(ours).toBeTruthy();
    expect(ours.status).toBe("running");

    // ── Delete ──────────────────────────────────────────────
    const delResp = await fetch(
      `${BASE_URL}/api/projects/${PROJECT_NAME}?token=${encodeURIComponent(TOKEN)}`,
      { method: "DELETE" }
    );
    expect(delResp.status).toBe(200);
    const deleted = await delResp.json();
    expect(deleted.name).toBe(PROJECT_NAME);
    expect(deleted.status).toBe("stopped");

    // Verify it no longer appears as running
    const listResp2 = await fetch(
      `${BASE_URL}/api/projects?token=${encodeURIComponent(TOKEN)}`
    );
    const { projects: after } = await listResp2.json();
    const stale = after.find((p) => p.name === PROJECT_NAME);
    expect(!stale || stale.status !== "running").toBe(true);
  });
});
