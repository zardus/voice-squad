// @ts-check
/**
 * WebSocket protocol tests — connection, authentication, message handling.
 * Uses Playwright browser context to create WebSocket connections.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl, BASE_URL } = require("./helpers/config");

test.describe("WebSocket", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("connects with valid token and receives 'connected' message", async ({ page }) => {
    await page.goto(pageUrl());

    const msg = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected") {
              ws.close();
              resolve(m);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN });

    expect(msg.type).toBe("connected");
    expect(["claude", "codex"]).toContain(msg.captain);
  });

  test("rejects connection without token", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://localhost:${location.port}`);
        ws.onopen = () => resolve("connected");
        ws.onclose = () => resolve("rejected");
        ws.onerror = () => resolve("rejected");
        setTimeout(() => resolve("timeout"), 5000);
      });
    });

    expect(result).toBe("rejected");
  });

  test("rejects connection with invalid token", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=invalid-token-xyz`);
        ws.onopen = () => resolve("connected");
        ws.onclose = () => resolve("rejected");
        ws.onerror = () => resolve("rejected");
        setTimeout(() => resolve("timeout"), 5000);
      });
    });

    expect(result).toBe("rejected");
  });

  test("receives tmux_snapshot messages after connection", async ({ page }) => {
    await page.goto(pageUrl());

    const snapshot = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "tmux_snapshot") {
              ws.close();
              resolve(m);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        // tmux_snapshot comes every 1s, give it 5s
        setTimeout(() => reject(new Error("no tmux_snapshot received within 5s")), 5000);
      });
    }, { token: TOKEN });

    expect(snapshot.type).toBe("tmux_snapshot");
    expect(typeof snapshot.content).toBe("string");
  });

  test("responds to unknown message type with error", async ({ page }) => {
    await page.goto(pageUrl());

    const resp = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        let connected = false;
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected") {
              connected = true;
              ws.send(JSON.stringify({ type: "totally_bogus_type" }));
            } else if (m.type === "error" && connected) {
              ws.close();
              resolve(m);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN });

    expect(resp.type).toBe("error");
    expect(resp.message).toContain("Unknown type");
  });

  test("handles invalid JSON gracefully", async ({ page }) => {
    await page.goto(pageUrl());

    const resp = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        let connected = false;
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected") {
              connected = true;
              ws.send("this is not json{{{");
            } else if (m.type === "error" && connected) {
              ws.close();
              resolve(m);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN });

    expect(resp.type).toBe("error");
    expect(resp.message).toContain("Invalid JSON");
  });

  test("text_command is accepted without error", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        let sentCommand = false;
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected" && !sentCommand) {
              sentCommand = true;
              // Send an empty-ish command that won't do anything harmful
              ws.send(JSON.stringify({ type: "text_command", text: "" }));
              // Wait briefly, if no error comes back it was accepted
              setTimeout(() => { ws.close(); resolve("ok"); }, 2000);
            } else if (m.type === "error" && sentCommand) {
              ws.close();
              resolve("error: " + m.message);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 10000);
      });
    }, { token: TOKEN });

    // Empty text should be silently ignored (server checks msg.text && msg.text.trim())
    expect(result).toBe("ok");
  });

  test("status_tab_active / status_tab_inactive messages accepted", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${location.port}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected") {
              ws.send(JSON.stringify({ type: "status_tab_active" }));
              // Brief delay then deactivate
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "status_tab_inactive" }));
                setTimeout(() => { ws.close(); resolve("ok"); }, 500);
              }, 500);
            } else if (m.type === "error") {
              ws.close();
              resolve("error: " + m.message);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 10000);
      });
    }, { token: TOKEN });

    expect(result).toBe("ok");
  });
});
