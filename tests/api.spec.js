// @ts-check
/**
 * HTTP API endpoint tests — test all server routes with valid/invalid auth.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");
const fs = require("fs/promises");
const path = require("path");

const SUMMARIES_DIR =
  process.env.SQUAD_SUMMARIES_DIR || "/home/ubuntu/captain/archive/summaries";
const TEST_PREFIX = `playwright-completed-${Date.now()}`;

test.describe("API endpoints", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  async function cleanupTestSummaries() {
    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    const entries = await fs.readdir(SUMMARIES_DIR);
    await Promise.all(entries
      .filter((name) => name.includes(TEST_PREFIX))
      .map((name) => fs.unlink(path.join(SUMMARIES_DIR, name)).catch(() => {})));
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
    const older = {
      task_name: `${TEST_PREFIX}-older`,
      completed_at: "2026-02-11T09:40:00Z",
      short_summary: "Older summary",
      detailed_summary: "Older details",
      task_definition: "Older definition",
      worker_type: "codex",
      session: "alpha",
      window: "w1",
    };
    const newer = {
      task_name: `${TEST_PREFIX}-newer`,
      completed_at: "2026-02-11T09:43:00Z",
      short_summary: "Newer summary",
      detailed_summary: "Newer details",
      task_definition: "Newer definition",
      worker_type: "codex",
      session: "alpha",
      window: "w2",
    };

    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SUMMARIES_DIR, `20260211T094000Z_${TEST_PREFIX}-older.json`),
      JSON.stringify(older, null, 2)
    );
    await fs.writeFile(
      path.join(SUMMARIES_DIR, `20260211T094300Z_${TEST_PREFIX}-newer.json`),
      JSON.stringify(newer, null, 2)
    );

    const resp = await fetch(`${BASE_URL}/api/completed-tasks?token=${encodeURIComponent(TOKEN)}`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(Array.isArray(json.tasks)).toBe(true);

    const ours = json.tasks.filter((task) => String(task.task_name || "").startsWith(TEST_PREFIX));
    expect(ours).toHaveLength(2);
    expect(ours[0].task_name).toBe(newer.task_name);
    expect(ours[1].task_name).toBe(older.task_name);
  });

  test("POST /api/completed-tasks writes summary file", async () => {
    const taskName = `${TEST_PREFIX}-post`;
    const payload = {
      token: TOKEN,
      task_name: taskName,
      completed_at: "2026-02-11T10:00:00Z",
      short_summary: "One-line done summary",
      detailed_summary: "## Done\n- Added tests",
      task_definition: "Original task markdown",
      worker_type: "codex",
      session: "challenges",
      window: "v8-redo",
    };

    const resp = await fetch(`${BASE_URL}/api/completed-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(201);
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.file).toContain(taskName);

    const createdPath = path.join(SUMMARIES_DIR, json.file);
    const raw = await fs.readFile(createdPath, "utf8");
    const saved = JSON.parse(raw);
    expect(saved.task_name).toBe(taskName);
    expect(saved.completed_at).toBe(payload.completed_at);
    expect(saved.short_summary).toBe(payload.short_summary);
  });
});
