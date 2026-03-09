// @ts-check
/**
 * Heartbeat tests — verify pane-monitor.sh injects HEARTBEAT MESSAGE
 * into the overseer pane when the overseer is idle.
 *
 * docker-compose.test.yml sets HEARTBEAT_INTERVAL_SECONDS=5 so we
 * don't have to wait 15 minutes.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN } = require("./helpers/config");
const { overseerExec } = require("./helpers/tmux");

test.describe("Heartbeat", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists");
    // Respawn overseer:0 with a clean bash shell so our assertions work
    // against a plain prompt (not Claude Code).
    try { overseerExec("respawn-pane -k -t overseer:0 bash"); } catch {}
  });

  test("injects HEARTBEAT MESSAGE into idle overseer pane", async () => {
    test.setTimeout(120000);

    // Clear the overseer pane so we can detect the heartbeat cleanly.
    overseerExec("send-keys -t overseer:0 'clear' Enter");
    await new Promise((r) => setTimeout(r, 2000));

    // The pane-monitor runs in its own container with HEARTBEAT_INTERVAL_SECONDS=5.
    // Poll for the heartbeat message (generous timeout for CI overhead).
    const deadline = Date.now() + 90000; // 90s generous timeout
    let overseerOutput = "";
    while (Date.now() < deadline) {
      try {
        overseerOutput = overseerExec("capture-pane -t overseer:0 -p -S -200");
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (overseerOutput.includes("HEARTBEAT MESSAGE")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Join lines to handle tmux line-wrapping that splits words across lines
    const joined = overseerOutput.replace(/\n/g, " ");
    expect(joined).toContain("HEARTBEAT MESSAGE");
    expect(joined).toContain("check on all active workers");
    expect(joined).toContain("use speak");
  });
});
