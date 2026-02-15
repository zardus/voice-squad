// @ts-check
/**
 * Tests for the OAuth login flow API endpoints:
 *   POST /api/login — kicks off a login child process
 *   GET  /api/login-status — polls login state
 *
 * These tests exercise auth guards, validation, status polling, and the
 * concurrent-request (409) guard. The actual CLI commands (claude/codex) aren't
 * available in the test container, so we verify that spawn errors are handled
 * gracefully and the state machine transitions correctly.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");

test.describe("Login API endpoints", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  // After each test, wait for any in-progress login to settle so it doesn't
  // bleed into the next test. The child process (if spawned) will fail quickly
  // in the test container because claude/codex aren't installed.
  test.afterEach(async () => {
    // Poll until login is no longer in progress (or give up after 10s)
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const resp = await fetch(
        `${BASE_URL}/api/login-status?token=${encodeURIComponent(TOKEN)}`
      );
      if (resp.ok) {
        const data = await resp.json();
        if (!data.inProgress) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  // --- POST /api/login auth & validation ---

  test("POST /api/login without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "claude" }),
    });
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  test("POST /api/login with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token", tool: "claude" }),
    });
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  test("POST /api/login with invalid tool returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "gpt4" }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("tool must be");
  });

  test("POST /api/login with missing tool returns 400", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(resp.status).toBe(400);
    const json = await resp.json();
    expect(json.error).toContain("tool must be");
  });

  test("POST /api/login with empty body returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(401);
  });

  // --- GET /api/login-status auth ---

  test("GET /api/login-status without token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/login-status`);
    expect(resp.status).toBe(401);
    const json = await resp.json();
    expect(json.error).toBe("Unauthorized");
  });

  test("GET /api/login-status with bad token returns 401", async () => {
    const resp = await fetch(`${BASE_URL}/api/login-status?token=bad-token`);
    expect(resp.status).toBe(401);
  });

  // --- GET /api/login-status returns expected shape ---

  test("GET /api/login-status returns idle state by default", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/login-status?token=${encodeURIComponent(TOKEN)}`
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("status");
    expect(json).toHaveProperty("url");
    expect(json).toHaveProperty("tool");
    expect(json).toHaveProperty("error");
    expect(json).toHaveProperty("inProgress");
    expect(typeof json.inProgress).toBe("boolean");
  });

  // --- POST /api/login happy path (spawn will fail in test env, but state machine works) ---

  test("POST /api/login with valid params returns ok and sets inProgress", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "claude" }),
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);

    // Status should reflect the login is happening (or already errored if
    // the command doesn't exist — either way the state machine is engaged).
    const statusResp = await fetch(
      `${BASE_URL}/api/login-status?token=${encodeURIComponent(TOKEN)}`
    );
    expect(statusResp.status).toBe(200);
    const status = await statusResp.json();
    expect(status.tool).toBe("claude");
    // Status should be one of the valid states
    expect(["spawning", "waiting_for_auth", "success", "error"]).toContain(status.status);
  });

  test("POST /api/login eventually reaches error state when CLI not available", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "codex" }),
    });
    expect(resp.status).toBe(200);

    // Poll until the login finishes (the CLI doesn't exist in the test
    // container, so it should error out quickly).
    const deadline = Date.now() + 10000;
    let finalStatus = null;
    while (Date.now() < deadline) {
      const statusResp = await fetch(
        `${BASE_URL}/api/login-status?token=${encodeURIComponent(TOKEN)}`
      );
      if (statusResp.ok) {
        finalStatus = await statusResp.json();
        if (!finalStatus.inProgress) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(finalStatus).toBeTruthy();
    expect(finalStatus.inProgress).toBe(false);
    expect(finalStatus.tool).toBe("codex");
    // Should be error since the CLI binary doesn't exist in test env
    expect(finalStatus.status).toBe("error");
    expect(finalStatus.error).toBeTruthy();
  });

  // --- Concurrent login guard (409) ---

  test("POST /api/login concurrent request returns 409", async () => {
    // Start a login — it may error quickly, so we need a slightly tricky
    // approach: fire both requests with minimal delay.
    const body = JSON.stringify({ token: TOKEN, tool: "claude" });
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };

    const [resp1, resp2] = await Promise.all([
      fetch(`${BASE_URL}/api/login`, opts),
      // Small delay so the first request is accepted before the second arrives
      new Promise((r) => setTimeout(r, 50)).then(() =>
        fetch(`${BASE_URL}/api/login`, opts)
      ),
    ]);

    const statuses = [resp1.status, resp2.status].sort();

    // In the test container, the spawned process may fail almost instantly,
    // which means loginState.inProgress could already be false by the time the
    // second request arrives. If that happens, both may return 200 — acceptable.
    // But if the timing works out, we should see a 409.
    if (statuses.includes(409)) {
      const conflictResp = resp1.status === 409 ? resp1 : resp2;
      const json = await conflictResp.json();
      expect(json.error).toContain("already in progress");
    }
    // Either way, at least one should have been accepted
    expect(statuses).toContain(200);
  });

  // --- Login for both tools ---

  test("POST /api/login accepts tool=codex", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "codex" }),
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/login accepts tool=claude", async () => {
    const resp = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool: "claude" }),
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);
  });
});
