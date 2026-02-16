// @ts-check
/**
 * Docker / infrastructure tests — verify the running containers have all
 * expected processes and services alive.
 */
const { test, expect } = require("@playwright/test");
const { BASE_URL, TOKEN } = require("./helpers/config");
const { captainExec, workspaceExec } = require("./helpers/tmux");
const http = require("http");

test.describe("Docker infrastructure", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
  });

  test("voice server responds on port 3000", async () => {
    const resp = await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}?token=${TOKEN}`, (res) => {
        res.resume();
        resolve(res);
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    expect(resp.statusCode).toBe(200);
  });

  test("voice server /api/status responds", async () => {
    const resp = await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/api/status?token=${TOKEN}`, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, data }));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    expect(resp.status).toBe(200);
    const json = JSON.parse(resp.data);
    expect(json).toHaveProperty("sessions");
  });

  test("workspace tmux server is running", () => {
    const out = workspaceExec("list-sessions 2>&1 || true");
    expect(out).not.toContain("no server running");
    expect(out).not.toContain("error connecting");
  });

  test("captain tmux session exists", () => {
    const out = captainExec("list-sessions -F '#{session_name}'");
    expect(out).toContain("captain");
  });

  test("captain tmux session has expected windows", () => {
    const out = captainExec("list-windows -t captain -F '#{window_name}'");
    const windows = out.trim().split("\n");
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  test("captain pane has content", () => {
    const out = captainExec("capture-pane -t captain:0 -p -S -50");
    // Should have some content (even if just a shell prompt)
    expect(out.trim().length).toBeGreaterThan(0);
  });
});
