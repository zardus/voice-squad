// @ts-check
/**
 * Squad MCP server tests.
 *
 * These run inside the Docker test container (see Dockerfile.test) and validate:
 * - core tmux orchestration tools exist
 * - capture-pane-delta works
 * - filtered capture strips interactive input chrome markers
 * - captain/worker restart tools exist (smoke)
 * - start-worker honors the cwd parameter
 */
const { test, expect } = require("@playwright/test");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const execFileAsync = promisify(execFile);

// Helper to kill a tmux session directly (no MCP tool for kill-session)
async function killTmuxSession(name) {
  await execFileAsync("tmux", ["kill-session", "-t", name]).catch(() => {});
}

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
    expect(names).toContain("tmux-list-sessions");
    expect(names).toContain("tmux-list-windows");
    expect(names).toContain("tmux-list-panes");
    expect(names).toContain("send-worker-command");
    expect(names).toContain("send-worker-key");
    expect(names).toContain("start-worker");
    expect(names).toContain("create-project-session");
    expect(names).toContain("kill-worker");
    expect(names).toContain("stop-worker");
    expect(names).toContain("restart-pane-agent");
    expect(names).toContain("restart-workers");
    expect(names).toContain("restart-captain");
    expect(names).toContain("list-agents");
    expect(names).toContain("list-workers");
    expect(names).toContain("check-worker-status");
  });

  test("start-worker schema includes optional cwd parameter", async () => {
    const res = await client.request("tools/list", {});
    const startWorker = (res.tools || []).find((t) => t.name === "start-worker");
    expect(startWorker).toBeTruthy();
    const props = startWorker.inputSchema?.properties || {};
    expect(props.cwd).toBeTruthy();
    // cwd should not be in the required list (it's optional)
    const required = startWorker.inputSchema?.required || [];
    expect(required).not.toContain("cwd");
  });

  test("can create a session, run a command, and capture output", async () => {
    // Create an isolated session.
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-test", path: "/home/ubuntu" },
    });

    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-test:0", command: "printf 'hello-from-mcp\\n'" },
    });

    const cap = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-test:0", lines: 120, mode: "raw" },
    });
    const text = cap.content?.[0]?.text || "";
    expect(text).toContain("hello-from-mcp");

    await killTmuxSession("mcp-test");
  });

  test("filtered capture strips a simulated input chrome section", async () => {
    const PROMPT = "\u276f prompt";
    const DELIM = "\u2500".repeat(10);
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-filter", path: "/home/ubuntu" },
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
      name: "send-worker-command",
      arguments: { target: "mcp-filter:0", command: cmd },
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

    await killTmuxSession("mcp-filter");
  });

  test("capture-pane-delta returns only new output after reset", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-delta", path: "/home/ubuntu" },
    });

    await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-delta:0", reset: true, overlap: 3, mode: "raw" },
    });

    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-delta:0", command: "echo DELTA_LINE_1" },
    });

    const delta = await client.request("tools/call", {
      name: "capture-pane-delta",
      arguments: { paneId: "mcp-delta:0", reset: false, overlap: 3, mode: "raw" },
    });
    const dText = delta.content?.[0]?.text || "";
    expect(dText).toContain("DELTA_LINE_1");

    await killTmuxSession("mcp-delta");
  });

  test("capture-pane-delta truncates output to maxLines keeping most recent lines", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-trunc", path: "/home/ubuntu" },
    });

    // Generate 60 numbered lines so we can verify which ones survive truncation.
    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: {
        target: "mcp-trunc:0",
        command: "for i in $(seq 1 60); do echo \"LINE_$i\"; done",
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

    await killTmuxSession("mcp-trunc");
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
      name: "create-project-session",
      arguments: { project_name: "mcp-inputbox", path: "/home/ubuntu" },
    });

    // Phase 1: Write 30 stable lines + 5 "old" bottom lines, clear scrollback
    const writePhase1 = [
      "printf '\\033[2J\\033[H';",
      "for i in $(seq 1 30); do echo \"STABLE_$i\"; done;",
      "for i in $(seq 1 5); do echo \"OLDBOT_$i\"; done;",
      "tmux clear-history -t mcp-inputbox:0",
    ].join(" ");
    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-inputbox:0", command: writePhase1 },
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
      name: "send-worker-command",
      arguments: { target: "mcp-inputbox:0", command: writePhase2 },
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

    await killTmuxSession("mcp-inputbox");
  });

  // ---------------------------------------------------------------------------
  // list-workers and check-worker-status tests
  // ---------------------------------------------------------------------------

  test("list-workers returns worker info for project sessions", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-lw-test", path: "/home/ubuntu" },
    });

    // Send a simple command so the pane has something running
    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-lw-test:0", command: "echo hello" },
    });

    const res = await client.request("tools/call", { name: "list-workers", arguments: {} });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.workers).toBeDefined();
    expect(Array.isArray(data.workers)).toBeTruthy();

    // Should find our test session
    const worker = data.workers.find((w) => w.project === "mcp-lw-test");
    expect(worker).toBeTruthy();
    expect(worker.project).toBe("mcp-lw-test");
    expect(worker.cwd).toBeDefined();

    await killTmuxSession("mcp-lw-test");
  });

  test("check-worker-status returns status for existing pane", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-cs-test", path: "/home/ubuntu" },
    });

    const res = await client.request("tools/call", {
      name: "check-worker-status",
      arguments: { target: "mcp-cs-test:0" },
    });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.status).toBeDefined();
    expect(data.project).toBe("mcp-cs-test");
    expect(data.paneId).toBeDefined();
    // It's running a shell, not an agent, so status should be "exited"
    expect(data.status).toBe("exited");

    await killTmuxSession("mcp-cs-test");
  });

  test("check-worker-status returns not_found for nonexistent pane", async () => {
    const res = await client.request("tools/call", {
      name: "check-worker-status",
      arguments: { target: "nonexistent-session:99" },
    });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.status).toBe("not_found");
  });

  test("stop-worker sends Ctrl-C without killing window", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-stop-test", path: "/home/ubuntu" },
    });

    // Run a long sleep so we can stop it
    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-stop-test:0", command: "sleep 999" },
    });
    await new Promise((r) => setTimeout(r, 500));

    // Stop the worker
    const res = await client.request("tools/call", {
      name: "stop-worker",
      arguments: { target: "mcp-stop-test:0" },
    });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.ok).toBe(true);

    // Window should still exist
    const panes = await client.request("tools/call", {
      name: "tmux-list-panes",
      arguments: { target: "mcp-stop-test" },
    });
    const panesData = JSON.parse(panes.content?.[0]?.text || "{}");
    expect(panesData.panes.length).toBeGreaterThan(0);

    await killTmuxSession("mcp-stop-test");
  });

  // ---------------------------------------------------------------------------
  // Codex input prompt detection tests
  // ---------------------------------------------------------------------------

  test("list-workers detects codex alive at input prompt (not reported as exited)", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-codex-detect", path: "/home/ubuntu" },
    });

    // Simulate a codex input prompt: › prompt, "? for shortcuts", "85% context left"
    // The pane's currentCommand will be "bash" (not "codex"), but the content
    // should trigger detectCodexAlive and report the worker as running.
    const cmd = [
      "printf '\\033[2J\\033[H';",
      "echo 'Some previous output';",
      "echo '';",
      "printf '\\xe2\\x80\\xba Explain this codebase\\n';",
      "echo '';",
      "printf '  ? for shortcuts                                    85%% context left\\n';",
    ].join(" ");

    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-codex-detect:0", command: cmd },
    });

    // Wait for the codex prompt markers to appear
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-codex-detect:0", lines: 100, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("context left") && raw.includes("? for shortcuts")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(raw).toContain("context left");
    }

    // list-workers should detect this as a live codex worker
    const res = await client.request("tools/call", { name: "list-workers", arguments: {} });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    const worker = data.workers.find((w) => w.project === "mcp-codex-detect");
    expect(worker).toBeTruthy();
    expect(worker.agent).toBe("codex");
    expect(worker.status).toBe("running");

    await killTmuxSession("mcp-codex-detect");
  });

  test("check-worker-status detects codex alive at input prompt", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-codex-cs", path: "/home/ubuntu" },
    });

    // Simulate codex input prompt
    const cmd = [
      "printf '\\033[2J\\033[H';",
      "echo 'Task output here';",
      "printf '\\xe2\\x80\\xba \\n';",
      "printf '  ? for shortcuts                                    72%% context left\\n';",
    ].join(" ");

    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-codex-cs:0", command: cmd },
    });

    // Wait for markers
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-codex-cs:0", lines: 100, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("context left") && raw.includes("? for shortcuts")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(raw).toContain("context left");
    }

    const res = await client.request("tools/call", {
      name: "check-worker-status",
      arguments: { target: "mcp-codex-cs:0" },
    });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.agent).toBe("codex");
    expect(data.status).toBe("running");

    await killTmuxSession("mcp-codex-cs");
  });

  test("check-worker-status reports exited for plain shell (no codex prompt)", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-no-codex", path: "/home/ubuntu" },
    });

    // Just a plain shell with no codex markers
    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-no-codex:0", command: "echo 'just a shell'" },
    });
    await new Promise((r) => setTimeout(r, 500));

    const res = await client.request("tools/call", {
      name: "check-worker-status",
      arguments: { target: "mcp-no-codex:0" },
    });
    const data = JSON.parse(res.content?.[0]?.text || "{}");
    expect(data.agent).toBeNull();
    expect(data.status).toBe("exited");

    await killTmuxSession("mcp-no-codex");
  });

  test("filtered capture strips codex input prompt (› character)", async () => {
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-codex-filter", path: "/home/ubuntu" },
    });

    // Use node to print codex-style prompt markers. The command echo contains
    // escaped "\u203a" (6 ASCII chars), while node outputs the actual › (U+203A)
    // character. We check for the actual character to avoid false positives.
    const cmd = [
      "node -e",
      "\"console.log('CODEX_TOP_CONTENT'); console.log(''); console.log('\\u203a Some suggestion'); console.log('  ' + String.fromCharCode(63) + ' for shortcuts                                    90' + String.fromCharCode(37) + ' context left')\"",
    ].join(" ");

    await client.request("tools/call", {
      name: "send-worker-command",
      arguments: { target: "mcp-codex-filter:0", command: cmd },
    });

    // Wait for output — check for actual › character (U+203A)
    {
      const deadline = Date.now() + 3000;
      let raw = "";
      while (Date.now() < deadline) {
        const cap = await client.request("tools/call", {
          name: "capture-pane",
          arguments: { target: "mcp-codex-filter:0", lines: 100, mode: "raw" },
        });
        raw = cap.content?.[0]?.text || "";
        if (raw.includes("\u203a") && raw.includes("CODEX_TOP_CONTENT")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(raw).toContain("\u203a");
    }

    // Filtered capture should strip the codex prompt line (starting with ›)
    const filtered = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-codex-filter:0", lines: 100, mode: "filtered" },
    });
    const fText = filtered.content?.[0]?.text || "";
    expect(fText).toContain("CODEX_TOP_CONTENT");
    // The actual › character (U+203A) should be stripped from filtered output.
    // Note: the command echo contains "\u203a" (ASCII escape), not the actual char.
    expect(fText).not.toContain("\u203a");

    // Raw should contain the actual › character
    const raw = await client.request("tools/call", {
      name: "capture-pane",
      arguments: { target: "mcp-codex-filter:0", lines: 100, mode: "raw" },
    });
    const rText = raw.content?.[0]?.text || "";
    expect(rText).toContain("CODEX_TOP_CONTENT");
    expect(rText).toContain("\u203a");

    await killTmuxSession("mcp-codex-filter");
  });

  // ---------------------------------------------------------------------------
  // start-worker cwd tests
  // ---------------------------------------------------------------------------

  test("start-worker uses explicit cwd when provided", async () => {
    const testDir = "/tmp/test-worker-explicit-cwd";
    fs.mkdirSync(testDir, { recursive: true });

    // Create session with a DIFFERENT path so we can verify explicit cwd overrides it
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-cwd-explicit", path: "/home/ubuntu" },
    });

    // Start worker with explicit cwd
    const res = await client.request("tools/call", {
      name: "start-worker",
      arguments: {
        project_name: "mcp-cwd-explicit",
        task_name: "cwd-test",
        tool: "claude",
        prompt: "test",
        cwd: testDir,
      },
    });
    const resText = res.content?.[0]?.text || "";
    expect(resText).toContain('"ok": true');

    // Give pane a moment to initialize
    await new Promise((r) => setTimeout(r, 2000));

    // Check pane's working directory via tmux-list-panes
    const panes = await client.request("tools/call", {
      name: "tmux-list-panes",
      arguments: { target: "mcp-cwd-explicit" },
    });
    const panesData = JSON.parse(panes.content?.[0]?.text || "{}");
    const workerPane = (panesData.panes || []).find(
      (p) => p.windowName === "cwd-test"
    );
    expect(workerPane).toBeTruthy();
    expect(workerPane.currentPath).toBe(testDir);

    await killTmuxSession("mcp-cwd-explicit");
  });

  test("start-worker falls back to session directory when cwd omitted", async () => {
    const sessionDir = "/tmp/test-worker-session-cwd";
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create session with a specific working directory
    await client.request("tools/call", {
      name: "create-project-session",
      arguments: { project_name: "mcp-cwd-fallback", path: sessionDir },
    });

    // Start worker WITHOUT cwd — should inherit session's directory
    const res = await client.request("tools/call", {
      name: "start-worker",
      arguments: {
        project_name: "mcp-cwd-fallback",
        task_name: "fallback-test",
        tool: "claude",
        prompt: "test",
      },
    });
    const resText = res.content?.[0]?.text || "";
    expect(resText).toContain('"ok": true');

    // Give pane a moment to initialize
    await new Promise((r) => setTimeout(r, 2000));

    // Check pane's working directory via tmux-list-panes
    const panes = await client.request("tools/call", {
      name: "tmux-list-panes",
      arguments: { target: "mcp-cwd-fallback" },
    });
    const panesData = JSON.parse(panes.content?.[0]?.text || "{}");
    const workerPane = (panesData.panes || []).find(
      (p) => p.windowName === "fallback-test"
    );
    expect(workerPane).toBeTruthy();
    expect(workerPane.currentPath).toBe(sessionDir);

    await killTmuxSession("mcp-cwd-fallback");
  });
});
