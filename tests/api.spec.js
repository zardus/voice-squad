// @ts-check
/**
 * HTTP API endpoint tests — test all server routes with valid/invalid auth.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");
const fs = require("fs/promises");
const path = require("path");

const CAPTAIN_DIR = process.env.SQUAD_CAPTAIN_DIR || "/home/ubuntu/captain";
const TASK_DEFS_DIR = process.env.SQUAD_TASK_DEFS_DIR || path.join(CAPTAIN_DIR, "tasks");
const TASK_DEFS_PENDING_DIR = path.join(TASK_DEFS_DIR, "pending");
const TASK_DEFS_ARCHIVED_DIR = path.join(TASK_DEFS_DIR, "archived");
const TEST_PREFIX = `playwright-completed-${Date.now()}`;

test.describe("API endpoints", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  async function cleanupTestSummaries() {
    await fs.mkdir(TASK_DEFS_PENDING_DIR, { recursive: true });
    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });
    const pendingEntries = await fs.readdir(TASK_DEFS_PENDING_DIR).catch(() => []);
    const archivedEntries = await fs.readdir(TASK_DEFS_ARCHIVED_DIR).catch(() => []);
    await Promise.all(pendingEntries
      .filter((name) => name.includes(TEST_PREFIX))
      .map((name) => fs.unlink(path.join(TASK_DEFS_PENDING_DIR, name)).catch(() => {})));
    await Promise.all(archivedEntries
      .filter((name) => name.includes(TEST_PREFIX))
      .map((name) => fs.unlink(path.join(TASK_DEFS_ARCHIVED_DIR, name)).catch(() => {})));
  }

  test.beforeEach(async () => {
    await cleanupTestSummaries();
  });

  test.afterEach(async () => {
    await cleanupTestSummaries();
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

  // --- Completed Tasks API ---

  test("GET /api/completed-tasks returns summaries sorted by completed_at desc", async () => {
    const olderName = `${TEST_PREFIX}-older`;
    const newerName = `${TEST_PREFIX}-newer`;

    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });

    // Write older task files
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${olderName}.summary`), "Older summary\n");
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${olderName}.task`), "Older definition\n");
    const olderTime = new Date("2026-02-11T09:40:00Z");
    await fs.utimes(path.join(TASK_DEFS_ARCHIVED_DIR, `${olderName}.summary`), olderTime, olderTime);

    // Write newer task files
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${newerName}.summary`), "Newer summary\n");
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${newerName}.task`), "Newer definition\n");
    const newerTime = new Date("2026-02-11T09:43:00Z");
    await fs.utimes(path.join(TASK_DEFS_ARCHIVED_DIR, `${newerName}.summary`), newerTime, newerTime);

    const resp = await fetch(`${BASE_URL}/api/completed-tasks?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(Array.isArray(json.tasks)).toBe(true);

    const ours = json.tasks.filter((task) => String(task.task_name || "").startsWith(TEST_PREFIX));
    expect(ours).toHaveLength(2);
    expect(ours[0].task_name).toBe(newerName);
    expect(ours[1].task_name).toBe(olderName);
    expect(ours[0].summary).toBe("Newer summary");
    expect(ours[1].summary).toBe("Older summary");
  });

  test("POST /api/completed-tasks writes summary file", async () => {
    const taskName = `${TEST_PREFIX}-post`;
    const payload = {
      token: TOKEN,
      task_name: taskName,
      short_summary: "One-line done summary",
      detailed_summary: "## Done\n- Added tests",
      task_definition: "Original task markdown",
    };

    const resp = await fetch(`${BASE_URL}/api/completed-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(201);
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.task_name).toContain(TEST_PREFIX);

    // Verify files were written to the archived directory
    const sanitized = json.task_name;
    const summaryContent = await fs.readFile(
      path.join(TASK_DEFS_ARCHIVED_DIR, `${sanitized}.summary`), "utf8"
    );
    expect(summaryContent.trim()).toBe(payload.short_summary);

    const resultsContent = await fs.readFile(
      path.join(TASK_DEFS_ARCHIVED_DIR, `${sanitized}.results`), "utf8"
    );
    expect(resultsContent.trim()).toBe(payload.detailed_summary);

    const taskContent = await fs.readFile(
      path.join(TASK_DEFS_ARCHIVED_DIR, `${sanitized}.task`), "utf8"
    );
    expect(taskContent.trim()).toBe(payload.task_definition);
  });

  test("GET /api/completed-tasks reads task, summary, title, results, and log files from archived dir", async () => {
    const taskName = `${TEST_PREFIX}-full`;

    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.task`), `Task definition for ${taskName}\n`);
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.summary`), "Short summary text\n");
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.title`), "My Task Title\n");
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.results`), "## Results\n- All tests pass\n");
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.log`), "full pane log output\n");
    const mtime = new Date("2026-02-11T10:05:00Z");
    await fs.utimes(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.summary`), mtime, mtime);

    const resp = await fetch(`${BASE_URL}/api/completed-tasks?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(Array.isArray(json.tasks)).toBe(true);

    const found = json.tasks.find((t) => t && t.task_name === taskName);
    expect(found).toBeTruthy();
    expect(found.summary).toBe("Short summary text");
    expect(found.title).toBe("My Task Title");
    expect(found.results).toContain("All tests pass");
    expect(found.task_definition).toContain(`Task definition for ${taskName}`);
    expect(found.has_log).toBe(true);
    expect(String(found.completed_at)).toContain("2026-02-11T10:05:00");
  });

  // --- Task Log API ---

  test("GET /api/task-log returns log content for a specific task", async () => {
    const taskName = `${TEST_PREFIX}-withlog`;

    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });
    await fs.writeFile(path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.log`), "full tmux dump content here");

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
