// @ts-check
/**
 * Heartbeat tests — verify pane-monitor.sh injects HEARTBEAT MESSAGE
 * into the captain pane when the captain is idle.
 *
 * docker-compose.test.yml sets HEARTBEAT_INTERVAL_SECONDS=5 so we
 * don't have to wait 15 minutes.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN } = require("./helpers/config");
const { captainExec } = require("./helpers/tmux");

test.describe("Heartbeat", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
    // Respawn captain:0 with a clean bash shell so our assertions work
    // against a plain prompt (not Claude Code).
    try { captainExec("respawn-pane -k -t captain:0 bash"); } catch {}
  });

  test("injects HEARTBEAT MESSAGE into idle captain pane", async () => {
    test.setTimeout(120000);

    // Clear the captain pane so we can detect the heartbeat cleanly.
    captainExec("send-keys -t captain:0 'clear' Enter");
    await new Promise((r) => setTimeout(r, 2000));

    // The pane-monitor runs in its own container with HEARTBEAT_INTERVAL_SECONDS=5.
    // Poll for the heartbeat message (generous timeout for CI overhead).
    const deadline = Date.now() + 90000; // 90s generous timeout
    let captainOutput = "";
    while (Date.now() < deadline) {
      try {
        captainOutput = captainExec("capture-pane -t captain:0 -p -S -200");
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (captainOutput.includes("HEARTBEAT MESSAGE")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Join lines to handle tmux line-wrapping that splits words across lines
    const joined = captainOutput.replace(/\n/g, " ");
    expect(joined).toContain("HEARTBEAT MESSAGE");
    expect(joined).toContain("please do a check of the current tasks");
    expect(joined).toContain("use the speak command");
  });
});
