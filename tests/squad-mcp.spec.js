// @ts-check
/**
 * Squad MCP server tests.
 *
 * These run inside the Docker test container (see Dockerfile.test) and validate:
 * - core tmux orchestration tools exist
 * - capture-pane-delta works
 * - filtered capture strips interactive input chrome markers
 * - captain/worker restart tools exist (smoke)
 */
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function resolveServerPath() {
  if (fs.existsSync("/opt/squad/squad-mcp/server.js")) return "/opt/squad/squad-mcp/server.js";
  return path.join(__dirname, "..", "src", "squad-mcp", "server.js");
}

class McpStdioClient {
  /**
   * @param {import("child_process").ChildProcessWithoutNullStreams} proc
   */
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
        else p.resolve(msg.result);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    const payload = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  async close() {
    try { this.rl.close(); } catch {}
    try { this.proc.kill(); } catch {}
  }
}

test.describe("squad MCP server", () => {
  /** @type {import("child_process").ChildProcessWithoutNullStreams | null} */
  let proc = null;
  /** @type {McpStdioClient | null} */
  let client = null;

  test.beforeAll(async () => {
    const serverPath = resolveServerPath();
    proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => process.stderr.write("[squad-mcp] " + d.toString()));
    client = new McpStdioClient(proc);

    // MCP handshake.
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "voice-squad-tests", version: "1.0.0" },
    });
    client.notify("initialized", {});
  });

  test.afterAll(async () => {
    if (client) await client.close();
    client = null;
    proc = null;
  });

  test("exposes expected tools", async () => {
    const res = await client.request("tools/list", {});
    const names = (res.tools || []).map((t) => t.name);
    expect(names).toContain("capture-pane-delta");
    expect(names).toContain("capture-pane");
    expect(names).toContain("tmux-new-session");
    expect(names).toContain("tmux-new-window");
    expect(names).toContain("tmux-send-command");
    expect(names).toContain("restart-pane-agent");
    expect(names).toContain("restart-workers");
    expect(names).toContain("restart-captain");
  });

  test("can create a session, run a command, and capture output", async () => {
    // Create an isolated session.
    await client.request("tools/call", {
      name: "tmux-new-session",
      arguments: { sessionName: "mcp-test", cwd: "/home/ubuntu", killIfExists: true },
    });

    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: { target: "mcp-test:0", command: "printf 'hello-from-mcp\\n'", enterCount: 1, delayBeforeEnterMs: 50 },
    });

    const cap = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-test:0", lines: 120, mode: "raw" },
    });
    const text = cap.content?.[0]?.text || "";
    expect(text).toContain("hello-from-mcp");

    await client.request("tools/call", { name: "tmux-kill-session", arguments: { sessionName: "mcp-test" } });
  });

  test("filtered capture strips a simulated input chrome section", async () => {
    const PROMPT = "\u276f prompt";
    const DELIM = "\u2500".repeat(10);
    await client.request("tools/call", {
      name: "tmux-new-session",
      arguments: { sessionName: "mcp-filter", cwd: "/home/ubuntu", killIfExists: true },
    });

    // Produce output that looks like a CLI input section below a box-drawing delimiter.
    // Use node (available in the test container) to print unicode box drawing and a "❯" prompt marker
    // without embedding non-ASCII directly in this test file.
    const cmd = [
      "node -e",
      // Avoid including the string "BOTTOM" in the command line itself (it would appear in captures even if
      // filtering correctly removes the printed output line). Generate it from char codes instead.
      "\"console.log('TOP'); console.log('\\u2500'.repeat(40)); console.log('\\u276f prompt'); console.log(String.fromCharCode(66,79,84,84,79,77))\"",
    ].join(" ");

    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: { target: "mcp-filter:0", command: cmd, enterCount: 1, delayBeforeEnterMs: 50 },
    });

    // Wait for the command to actually execute and print the delimiter (the command line itself only contains "\\u2500").
    let lastRaw = "";
    {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-filter:0", lines: 250, mode: "raw" },
        });
        lastRaw = cap.content?.[0]?.text || "";
        if (lastRaw.includes(DELIM)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(lastRaw).toContain(DELIM);
    }

    const filtered = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-filter:0", lines: 200, mode: "filtered" },
    });
    const fText = filtered.content?.[0]?.text || "";
    expect(fText).toContain("TOP");
    expect(fText).not.toContain("BOTTOM");
    expect(fText).not.toContain(PROMPT);

    const raw = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-filter:0", lines: 200, mode: "raw" },
    });
    const rText = raw.content?.[0]?.text || "";
    expect(rText).toContain("BOTTOM");
    expect(rText).toContain(PROMPT);

    await client.request("tools/call", { name: "tmux-kill-session", arguments: { sessionName: "mcp-filter" } });
  });

  test("capture-pane-delta returns only new output after reset", async () => {
    await client.request("tools/call", {
      name: "tmux-new-session",
      arguments: { sessionName: "mcp-delta", cwd: "/home/ubuntu", killIfExists: true },
    });

    await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-delta:0", reset: true, overlap: 3, mode: "raw" },
    });

    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: { target: "mcp-delta:0", command: "echo DELTA_LINE_1", enterCount: 1, delayBeforeEnterMs: 50 },
    });

    const delta = await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-delta:0", reset: false, overlap: 3, mode: "raw" },
    });
    const dText = delta.content?.[0]?.text || "";
    expect(dText).toContain("DELTA_LINE_1");

    await client.request("tools/call", { name: "tmux-kill-session", arguments: { sessionName: "mcp-delta" } });
  });
});
