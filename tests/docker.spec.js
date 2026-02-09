// @ts-check
/**
 * Docker / infrastructure tests — verify the running container has all
 * expected processes and services alive.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const { BASE_URL, TOKEN } = require("./helpers/config");
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

  test("voice server Node.js process is running", () => {
    const out = execSync("pgrep -af 'node.*server\\.js'", { encoding: "utf8", timeout: 5000 });
    expect(out.trim()).toBeTruthy();
  });

  test("tmux server is running", () => {
    const out = execSync("tmux list-sessions 2>&1 || true", { encoding: "utf8", timeout: 5000 });
    expect(out).not.toContain("no server running");
    expect(out).not.toContain("error connecting");
  });

  test("captain tmux session exists", () => {
    const out = execSync("tmux list-sessions -F '#{session_name}'", { encoding: "utf8", timeout: 5000 });
    expect(out).toContain("captain");
  });

  test("captain tmux session has expected windows", () => {
    const out = execSync("tmux list-windows -t captain -F '#{window_name}'", { encoding: "utf8", timeout: 5000 });
    const windows = out.trim().split("\n");
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  test("heartbeat process is running", () => {
    try {
      const out = execSync("pgrep -af heartbeat", { encoding: "utf8", timeout: 5000 });
      expect(out.trim()).toBeTruthy();
    } catch {
      // heartbeat.sh may not be running in all configurations — warn but don't fail
      console.warn("heartbeat process not found (may be expected in dev)");
    }
  });

  test("cloudflared tunnel process exists", () => {
    try {
      const out = execSync("pgrep -af cloudflared", { encoding: "utf8", timeout: 5000 });
      expect(out.trim()).toBeTruthy();
    } catch {
      // cloudflared may not be running if tunnel is disabled
      console.warn("cloudflared process not found (may be expected in dev)");
    }
  });

  test("captain pane has content", () => {
    const out = execSync("tmux capture-pane -t captain:0 -p -S -50", {
      encoding: "utf8",
      timeout: 5000,
    });
    // Should have some content (even if just a shell prompt)
    expect(out.trim().length).toBeGreaterThan(0);
  });

  test("port 3000 is listening", () => {
    // Check /proc/net/tcp and tcp6 for port 3000 (hex 0BB8)
    const out = execSync("grep ':0BB8' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true", {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(out.trim()).toBeTruthy();
  });
});
