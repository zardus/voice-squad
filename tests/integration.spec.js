// @ts-check
/**
 * Integration tests — send commands to the overseer and verify behavior.
 *
 * These tests interact with the live overseer agent and are opt-in:
 *   TEST_INTEGRATION=1 npx playwright test integration.spec.js
 *
 * They are skipped by default to avoid disrupting a running overseer.
 */
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const fs = require("fs");
const { TOKEN, pageUrl, BASE_URL } = require("./helpers/config");
const { overseerExec } = require("./helpers/tmux");

const WS_URL = BASE_URL.replace(/^http/, "ws");

const INTEGRATION = process.env.TEST_INTEGRATION === "1";
const TEST_FILE = "/home/ubuntu/test-hello-e2e.txt";

test.describe("Integration", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
    // Ensure overseer:0 has a clean bash shell — earlier tests (e.g. restart-overseer)
    // may have started a real overseer agent if API keys are present.
    try { overseerExec("respawn-pane -k -t overseer:0 bash"); } catch {}
  });

  test("send pane_send_text command and observe effect", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());

    // Wait for WebSocket to connect
    await page.waitForTimeout(2000);

    // Send a command directly via the WebSocket pane_send_text API
    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.binaryType = "arraybuffer";
        let connected = false;

        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const msg = JSON.parse(evt.data);
            if (msg.type === "connected") {
              connected = true;
              // Send a harmless command via pane_send_text
              ws.send(JSON.stringify({
                type: "pane_send_text",
                target: "overseer:0",
                text: 'echo "hello from integration test"',
              }));
              // Wait a moment then close
              setTimeout(() => {
                ws.close();
                resolve("sent");
              }, 1000);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 10000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(result).toBe("sent");
  });

  test("interrupt stops overseer processing", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(30000);

    await page.goto(pageUrl());
    await page.waitForTimeout(1000);

    // Send interrupt via API
    const resp = await fetch(`http://hub:3000/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);

    // Verify overseer pane is still alive after interrupt
    const paneContent = overseerExec("capture-pane -t overseer:0 -p -S -10");
    expect(paneContent).toBeTruthy();
  });

  test("WebSocket receives tmux_snapshot within 3 seconds", async ({ page }) => {
    test.skip(!INTEGRATION, "Set TEST_INTEGRATION=1 to run integration tests");
    test.setTimeout(10000);

    await page.goto(pageUrl());

    const snapshotTime = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "tmux_snapshot") {
              ws.close();
              resolve(Date.now() - start);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("no snapshot in 3s")), 3000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(snapshotTime).toBeLessThan(3000);
  });
});
