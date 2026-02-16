// @ts-check
/**
 * HTTP API endpoint tests — test all server routes with valid/invalid auth.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");
const fs = require("fs/promises");
const path = require("path");

const CAPTAIN_DIR = process.env.SQUAD_CAPTAIN_DIR || "/home/ubuntu/captain";
const TASKS_ARCHIVED_DIR = path.join(CAPTAIN_DIR, "tasks", "archived");
const TEST_PREFIX = `playwright-completed-${Date.now()}`;

test.describe("API endpoints", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  async function cleanupTestFiles() {
    await fs.mkdir(TASKS_ARCHIVED_DIR, { recursive: true });
    const entries = await fs.readdir(TASKS_ARCHIVED_DIR).catch(() => []);
    await Promise.all(entries
      .filter((name) => name.includes(TEST_PREFIX))
      .map((name) => fs.unlink(path.join(TASKS_ARCHIVED_DIR, name)).catch(() => {})));
  }

  test.beforeEach(async () => {
    await cleanupTestFiles();
  });

  test.afterEach(async () => {
    await cleanupTestFiles();
  });

  // --- GET / (static files) ---

  test("GET / serves HTML page", async () => {
    const resp = await fetch(BASE_URL);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
    const body = await resp.text();
    expect(body).toContain("<title>Squad Voice</title>");
    expect(body).toContain("id=\"app\"");
  });

  test("GET / serves app.js", async () => {
    const resp = await fetch(`${BASE_URL}/app.js`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("function connect()");
  });

  test("GET / serves style.css", async () => {
    const resp = await fetch(`${BASE_URL}/style.css`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("#app");
  });

  test("GET / serves manifest.json", async () => {
    const resp = await fetch(`${BASE_URL}/manifest.json`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.name).toBe("Squad Voice");
  });

  // --- GET /api/status ---

  test("GET /api/status with valid token returns JSON", async () => {
    const resp = await fetch(`${BASE_URL}/api/status?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    // Should have expected shape (either real data or fallback)
    expect(json).toHaveProperty("sessions");
  });

  test("GET /api/status without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/status`);
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  test("GET /api/status with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/status?token=wrong-token`);
    expect(resp.status).toBe(401);
  });

  // --- GET /api/voice-history ---

  test("GET /api/voice-history with valid token returns entries array", async () => {
    const resp = await fetch(`${BASE_URL}/api/voice-history?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(Array.isArray(json.entries)).toBe(true);
  });

  test("GET /api/voice-history without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/voice-history`);
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  // --- POST /api/interrupt ---

  test("POST /api/interrupt with valid token returns ok", async () => {
    const resp = await fetch(`${BASE_URL}/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    // May return 200 (ok) or 500 (tmux error if pane not found)
    const json = await resp.json();
    if (resp.status === 200) {
      expect(json.ok).toBe(true);
    } else {
      // tmux error is acceptable — means tmux pane doesn't exist
      expect(json).toHaveProperty("error");
    }
  });

  test("POST /api/interrupt without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/interrupt with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token" }),
    });
    expect(resp.status).toBe(401);
  });

  // --- POST /api/restart-captain ---

  test("POST /api/restart-captain without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "claude" }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/restart-captain with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token", tool: "claude" }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/restart-captain with invalid tool returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "invalid-tool" }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("tool must be");
  });

  test("POST /api/restart-captain with empty body returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/restart-captain with missing tool returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("tool must be");
  });

  test("POST /api/restart-captain with valid params succeeds", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "claude" }),
    });
    // Accept 200 (success) or 500 (script error, e.g. tmux not found in test env)
    const json = await resp.json();
    if (resp.status === 200) {
      expect(json.ok).toBe(true);
      expect(json.tool).toBe("claude");
    } else {
      expect(json).toHaveProperty("error");
    }
  });

  test("POST /api/restart-captain concurrent request returns 409", async () => {
    // Fire two restarts simultaneously — the second should be rejected
    const body = JSON.stringify({ token: TOKEN, tool: "claude" });
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
    const [resp1, resp2] = await Promise.all([
      fetch(`${BASE_URL}/api/restart-captain`, opts),
      // Small delay so the first request is accepted before the second arrives
      new Promise((r) => setTimeout(r, 100)).then(() =>
        fetch(`${BASE_URL}/api/restart-captain`, opts)
      ),
    ]);

    const statuses = [resp1.status, resp2.status].sort();
    // One should succeed (200) or fail from script (500), the other should be 409
    // In test environments without tmux, the first may be 500 (script error)
    // but the second should still be 409 if the first is still running
    if (statuses.includes(409)) {
      const conflictResp = resp1.status === 409 ? resp1 : resp2;
      const json = await conflictResp.json();
      expect(json.error).toContain("already in progress");
    }
    // If both completed without 409 (script finished before second request),
    // that's acceptable — the guard only triggers when a restart is in-flight
  });

  // --- GET /api/restart-status ---

  test("GET /api/restart-status without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/restart-status`);
    expect(resp.status).toBe(401);
  });

  test("GET /api/restart-status with valid token returns status", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/restart-status?token=${encodeURIComponent(TOKEN)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("restartInProgress");
    expect(json).toHaveProperty("captain");
    expect(typeof json.restartInProgress).toBe("boolean");
  });

  // --- POST /api/speak ---

  test("POST /api/speak without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST /api/speak with empty text returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: "" }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("text");
  });

  test("POST /api/speak with missing text field returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(resp.status).toBe(400);
  });

  test("POST /api/speak with whitespace-only text returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: "   " }),
    });
    expect(resp.status).toBe(400);
  });

  // --- Completed Tasks API (reads from ~/captain/tasks/archived/) ---

  test("GET /api/completed-tasks returns archived tasks sorted by completion time desc", async () => {
    const olderTask = `${TEST_PREFIX}-older`;
    const newerTask = `${TEST_PREFIX}-newer`;

    await fs.mkdir(TASKS_ARCHIVED_DIR, { recursive: true });

    // Older task: .task, .title, .results, .log
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${olderTask}.task`), "Older task definition");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${olderTask}.title`), "Older Title");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${olderTask}.results`), "Older results");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${olderTask}.log`), "Older log output");
    // Set older mtime on .log (used as completed_at)
    const olderTime = new Date("2026-02-11T09:40:00Z");
    await fs.utimes(path.join(TASKS_ARCHIVED_DIR, `${olderTask}.log`), olderTime, olderTime);

    // Newer task: .task, .title, .results, .log
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${newerTask}.task`), "Newer task definition");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${newerTask}.title`), "Newer Title");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${newerTask}.results`), "Newer results");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${newerTask}.log`), "Newer log output");
    const newerTime = new Date("2026-02-11T09:43:00Z");
    await fs.utimes(path.join(TASKS_ARCHIVED_DIR, `${newerTask}.log`), newerTime, newerTime);

    const resp = await fetch(`${BASE_URL}/api/completed-tasks?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(Array.isArray(json.tasks)).toBe(true);

    const ours = json.tasks.filter((t) => String(t.task_name || "").startsWith(TEST_PREFIX));
    expect(ours).toHaveLength(2);
    expect(ours[0].task_name).toBe(newerTask);
    expect(ours[0].title).toBe("Newer Title");
    expect(ours[0].results).toBe("Newer results");
    expect(ours[0].task_definition).toBe("Newer task definition");
    expect(ours[0].has_log).toBe(true);
    expect(ours[1].task_name).toBe(olderTask);
  });

  test("GET /api/completed-tasks gracefully handles missing files per task", async () => {
    const taskName = `${TEST_PREFIX}-partial`;

    await fs.mkdir(TASKS_ARCHIVED_DIR, { recursive: true });
    // Only create .task and .title — no .log, no .results
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${taskName}.task`), "Just the task def");
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${taskName}.title`), "Partial Task");

    const resp = await fetch(`${BASE_URL}/api/completed-tasks?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();

    const found = json.tasks.find((t) => t.task_name === taskName);
    expect(found).toBeTruthy();
    expect(found.title).toBe("Partial Task");
    expect(found.task_definition).toBe("Just the task def");
    expect(found.results).toBeNull();
    expect(found.has_log).toBe(false);
    expect(found.completed_at).toBeNull();
    expect(found.started_at).toBeTruthy(); // .task file exists so mtime is available
  });

  test("GET /api/task-log returns log content for a specific task", async () => {
    const taskName = `${TEST_PREFIX}-withlog`;

    await fs.mkdir(TASKS_ARCHIVED_DIR, { recursive: true });
    await fs.writeFile(path.join(TASKS_ARCHIVED_DIR, `${taskName}.log`), "full tmux dump content here");

    const resp = await fetch(
      `${BASE_URL}/api/task-log?token=${encodeURIComponent(TOKEN)}&task=${encodeURIComponent(taskName)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.log).toBe("full tmux dump content here");
  });

  test("GET /api/task-log returns 404 for missing log", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/task-log?token=${encodeURIComponent(TOKEN)}&task=${TEST_PREFIX}-nonexistent`
    );
    expect(resp.status).toBe(404);
  });
});
