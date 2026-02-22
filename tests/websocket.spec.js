// @ts-check
/**
 * WebSocket protocol tests — connection, authentication, message handling.
 * Uses Playwright browser context to create WebSocket connections.
 */
const { test, expect } = require("@playwright/test");
const { TOKEN, pageUrl, BASE_URL } = require("./helpers/config");

const WS_URL = BASE_URL.replace(/^http/, "ws");

test.describe("WebSocket", () => {
  test.beforeAll(() => {
    if (!TOKEN) throw new Error("Cannot discover VOICE_TOKEN");
  });

  test("connects with valid token and receives 'connected' message", async ({ page }) => {
    await page.goto(pageUrl());

    const msg = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(msg.type).toBe("connected");
    expect(["claude", "codex"]).toContain(msg.captain);
  });

  test("new connections receive voice history payload", async ({ page }) => {
    await page.goto(pageUrl());

    const msg = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "voice_history") {
              ws.close();
              resolve(m);
            }
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(msg.type).toBe("voice_history");
    expect(Array.isArray(msg.entries)).toBe(true);
  });

  test("rejects connection without token", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(params.wsUrl);
        ws.onopen = () => resolve("connected");
        ws.onclose = () => resolve("rejected");
        ws.onerror = () => resolve("rejected");
        setTimeout(() => resolve("timeout"), 5000);
      });
    }, { wsUrl: WS_URL });

    expect(result).toBe("rejected");
  });

  test("rejects connection with invalid token", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${params.wsUrl}?token=invalid-token-xyz`);
        ws.onopen = () => resolve("connected");
        ws.onclose = () => resolve("rejected");
        ws.onerror = () => resolve("rejected");
        setTimeout(() => resolve("timeout"), 5000);
      });
    }, { wsUrl: WS_URL });

    expect(result).toBe("rejected");
  });

  test("receives tmux_snapshot messages after connection", async ({ page }) => {
    await page.goto(pageUrl());

    const snapshot = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(snapshot.type).toBe("tmux_snapshot");
    expect(typeof snapshot.content).toBe("string");
  });

  test("responds to unknown message type with error", async ({ page }) => {
    await page.goto(pageUrl());

    const resp = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(resp.type).toBe("error");
    expect(resp.message).toContain("Unknown type");
  });

  test("handles invalid JSON gracefully", async ({ page }) => {
    await page.goto(pageUrl());

    const resp = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(resp.type).toBe("error");
    expect(resp.message).toContain("Invalid JSON");
  });

  test("text_command is accepted without error", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    // Empty text should be silently ignored (server checks msg.text && msg.text.trim())
    expect(result).toBe("ok");
  });

  test("connected message includes lastSpeakText field", async ({ page }) => {
    await page.goto(pageUrl());

    const msg = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(msg.type).toBe("connected");
    // lastSpeakText should be present (null or string depending on history state)
    expect("lastSpeakText" in msg).toBe(true);
  });

  test("status_tab_active / status_tab_inactive messages accepted", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}`);
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
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(result).toBe("ok");
  });

  test("iOS clients requesting tts=mp3 receive mp3 tts_config", async ({ page }) => {
    await page.goto(pageUrl());

    const msg = await page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}&tts=mp3`);
        ws.onmessage = (evt) => {
          if (typeof evt.data !== "string") return;
          const m = JSON.parse(evt.data);
          if (m.type === "tts_config") {
            ws.close();
            resolve(m);
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(msg.type).toBe("tts_config");
    expect(msg.format).toBe("mp3");
    expect(msg.mime).toBe("audio/mpeg");
  });

  test("reconnect sends connected replay only (no immediate speak_text event)", async ({ page }) => {
    await page.goto(pageUrl());

    const result = await page.evaluate(async (params) => {
      const connectOnce = () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}&tts=mp3`);
        let connectedMsg = null;
        let speakTextCount = 0;
        ws.onmessage = (evt) => {
          if (typeof evt.data !== "string") return;
          const m = JSON.parse(evt.data);
          if (m.type === "connected") {
            connectedMsg = m;
            setTimeout(() => {
              ws.close();
              resolve({ connectedMsg, speakTextCount });
            }, 500);
          } else if (m.type === "speak_text") {
            speakTextCount += 1;
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout waiting for reconnect data")), 7000);
      });

      const first = await connectOnce();
      const second = await connectOnce();
      return { first, second };
    }, { token: TOKEN, wsUrl: WS_URL });

    expect(result.first.connectedMsg.type).toBe("connected");
    expect(result.second.connectedMsg.type).toBe("connected");
    expect("lastSpeakText" in result.first.connectedMsg).toBe(true);
    expect("lastSpeakText" in result.second.connectedMsg).toBe(true);
    expect(result.first.speakTextCount).toBe(0);
    expect(result.second.speakTextCount).toBe(0);
  });

  test("speak broadcasts speak_text and binary audio to mp3 websocket clients", async ({ page }) => {
    await page.goto(pageUrl());

    const uniqueText = `ios-mp3-${Date.now()}`;
    const capturePromise = page.evaluate(async (params) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${params.wsUrl}?token=${params.token}&tts=mp3`);
        window.__iosTestWs = ws;
        let sawConnected = false;
        let speakText = null;
        let binaryBytes = 0;

        ws.onmessage = (evt) => {
          if (typeof evt.data === "string") {
            const m = JSON.parse(evt.data);
            if (m.type === "connected") {
              sawConnected = true;
              return;
            }
            if (m.type === "speak_text" && m.text === params.text) {
              speakText = m.text;
              if (binaryBytes > 0) {
                ws.close();
                resolve({ sawConnected, speakText, binaryBytes });
              }
            }
            return;
          }

          const size = evt.data instanceof ArrayBuffer
            ? evt.data.byteLength
            : (evt.data && typeof evt.data.size === "number" ? evt.data.size : 0);
          binaryBytes += size;
          if (speakText && binaryBytes > 0) {
            ws.close();
            resolve({ sawConnected, speakText, binaryBytes });
          }
        };

        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout waiting for speak_text + binary")), 12000);
      });
    }, { wsUrl: WS_URL, token: TOKEN, text: uniqueText });

    const speakResp = await fetch(`${BASE_URL}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, text: uniqueText }),
    });

    if (speakResp.status !== 200) {
      await page.evaluate(() => {
        if (window.__iosTestWs && window.__iosTestWs.readyState <= 1) {
          window.__iosTestWs.close();
        }
      });
      await capturePromise.catch(() => null);
      expect(speakResp.status).toBe(500);
      return;
    }

    const capture = await capturePromise;
    expect(capture.sawConnected).toBe(true);
    expect(capture.speakText).toBe(uniqueText);
    expect(capture.binaryBytes).toBeGreaterThan(0);
  });
});
