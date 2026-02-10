// @ts-check
/**
 * main-menu.sh tests — verify non-interactive actions work in the test container.
 */
const { test, expect } = require("@playwright/test");
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");

test.describe("Main menu", () => {
  test("show-web-ui prints the URL and renders a QR code", () => {
    test.skip(!fs.existsSync("/opt/squad/main-menu.sh"), "Requires test container (/opt/squad/main-menu.sh)");
    test.skip(!fs.existsSync("/tmp/voice-url.txt"), "Requires running voice server (/tmp/voice-url.txt)");

    const url = fs.readFileSync("/tmp/voice-url.txt", "utf8").trim();
    expect(url).toContain("http://");
    expect(url).toContain("token=");

    const out = execFileSync("/opt/squad/main-menu.sh", ["--action", "show-web-ui"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(out).toContain("Web UI URL:");
    expect(out).toContain(url);
    expect(out).toContain("Scan to open Squad Voice:");
  });

  test("restart-idle-monitor starts pane-monitor in tmux", () => {
    test.skip(!fs.existsSync("/opt/squad/main-menu.sh"), "Requires test container (/opt/squad/main-menu.sh)");

    execFileSync("/opt/squad/main-menu.sh", ["--action", "restart-idle-monitor"], {
      encoding: "utf8",
      timeout: 15000,
    });

    const ps = execSync("pgrep -af '/opt/squad/pane-monitor\\.sh' || true", {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(ps.trim()).toBeTruthy();

    const windows = execSync("tmux list-windows -t captain -F '#{window_name}'", {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(windows).toContain("idle-monitor");
  });
});
