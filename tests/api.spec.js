// @ts-check
/**
 * HTTP API endpoint tests — test all server routes with valid/invalid auth.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");

test.describe("API endpoints", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
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
});
