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

  test("capture-pane-delta truncates output to maxLines keeping most recent lines", async () => {
    await client.request("tools/call", {
      name: "tmux-new-session",
      arguments: { sessionName: "mcp-trunc", cwd: "/home/ubuntu", killIfExists: true },
    });

    // Generate 60 numbered lines so we can verify which ones survive truncation.
    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: {
        target: "mcp-trunc:0",
        command: "for i in $(seq 1 60); do echo \"LINE_$i\"; done",
        enterCount: 1,
        delayBeforeEnterMs: 50,
      },
    });

    // Wait for the last line to appear.
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-trunc:0", lines: 200, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("LINE_60")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(raw).toContain("LINE_60");
    }

    // First delta call with maxLines=10 — should truncate to 10 most-recent lines.
    const delta = await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-trunc:0", reset: true, mode: "raw", maxLines: 10 },
    });
    const text = delta.content?.[0]?.text || "";

    // Should contain the truncation notice.
    expect(text).toContain("truncated");
    expect(text).toContain("lines omitted");

    // Should contain the last line (LINE_60) but NOT the first line (LINE_1).
    expect(text).toContain("LINE_60");
    expect(text).not.toContain("LINE_1");

    // Count non-header, non-truncation-notice content lines — should be at most 10.
    const bodyLines = text.split("\n").filter(
      (l) => !l.startsWith("[pane") && !l.startsWith("[truncated")
    );
    expect(bodyLines.length).toBeLessThanOrEqual(10);

    await client.request("tools/call", { name: "tmux-kill-session", arguments: { sessionName: "mcp-trunc" } });
  });

  test("capture-pane-delta ignores volatile bottom lines (input box simulation)", async () => {
    // Simulate the Claude Code / Codex input box problem: the visible pane
    // has stable content at the top and a constantly-changing input area at
    // the bottom. Without the bottom-line stripping fix, the delta would
    // always report "gap detected" because the suffix anchor (from the
    // previous capture's last few lines) never matches the current capture.
    //
    // We simulate this by using ANSI escape codes to clear + rewrite the
    // screen with identical top lines but different bottom lines, then
    // clearing scrollback so capture-pane sees only the visible screen.
    //
    // We use 30 stable lines + 5 volatile lines. After the shell prompt
    // (~1 line), the total is ~36 lines. Stripping the last 10 for
    // comparison leaves ~26 lines — all from the stable region.

    await client.request("tools/call", {
      name: "tmux-new-session",
      arguments: { sessionName: "mcp-inputbox", cwd: "/home/ubuntu", killIfExists: true },
    });

    // Phase 1: Write 30 stable lines + 5 "old" bottom lines, clear scrollback
    const writePhase1 = [
      "printf '\\033[2J\\033[H';",
      "for i in $(seq 1 30); do echo \"STABLE_$i\"; done;",
      "for i in $(seq 1 5); do echo \"OLDBOT_$i\"; done;",
      "tmux clear-history -t mcp-inputbox:0",
    ].join(" ");
    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: { target: "mcp-inputbox:0", command: writePhase1, enterCount: 1, delayBeforeEnterMs: 50 },
    });

    // Wait for phase 1 output
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-inputbox:0", lines: 100, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("STABLE_30") && raw.includes("OLDBOT_5")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(raw).toContain("STABLE_30");
    }

    // Reset delta baseline
    await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-inputbox:0", reset: true, mode: "raw", maxLines: 200 },
    });

    // Phase 2: Rewrite screen with SAME stable lines but DIFFERENT bottom lines
    const writePhase2 = [
      "printf '\\033[2J\\033[H';",
      "for i in $(seq 1 30); do echo \"STABLE_$i\"; done;",
      "for i in $(seq 1 5); do echo \"NEWBOT_$i\"; done;",
      "tmux clear-history -t mcp-inputbox:0",
    ].join(" ");
    await client.request("tools/call", {
      name: "tmux-send-command",
      arguments: { target: "mcp-inputbox:0", command: writePhase2, enterCount: 1, delayBeforeEnterMs: 50 },
    });

    // Wait for phase 2 output
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-inputbox:0", lines: 100, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("NEWBOT_5") && raw.includes("STABLE_30")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(raw).toContain("NEWBOT_5");
    }

    // The delta should NOT report "gap detected" — the stable region is
    // identical, only the bottom (input box area) changed.
    const delta = await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-inputbox:0", reset: false, mode: "raw", maxLines: 200 },
    });
    const dText = delta.content?.[0]?.text || "";
    expect(dText).not.toContain("gap detected");

    await client.request("tools/call", { name: "tmux-kill-session", arguments: { sessionName: "mcp-inputbox" } });
  });
});
