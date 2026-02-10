#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CAPTURE_LINES = 500;
const MIN_MATCH_LINES = 3; // suffix matching anchor size
// tmux 3.4+ does NOT interpret \t as tab in -F format strings.
// Use a multi-char delimiter that won't appear in pane/session values.
const SEP = "|||";

// Per-pane state tracking for capture-pane-delta:
// key = `${paneId}|${mode}` where mode is "filtered" or "raw"
const paneState = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tmux(args, { timeout = 8000 } = {}) {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function tmuxOk(args) {
  try {
    await tmux(args);
    return true;
  } catch {
    return false;
  }
}

function trimTrailingEmptyLines(lines) {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function looksLikeClaudeOrCodexInputChrome(linesAfterDelimiter) {
  // Heuristic: Claude Code uses a prompt line beginning with "❯" and often uses box drawing.
  // Codex uses "›" as its prompt and shows "? for shortcuts" / "XX% context left".
  // We only strip below delimiter if we see an interactive prompt beneath it.
  for (let i = 0; i < Math.min(60, linesAfterDelimiter.length); i++) {
    const l = linesAfterDelimiter[i] ?? "";
    if (l.trimStart().startsWith("❯")) return true;
    if (l.trimStart().startsWith("›")) return true;
    if (l.includes("Ctrl") && l.includes("Enter")) return true;
    if (l.includes("? for shortcuts")) return true;
    if (l.includes("┌") || l.includes("└") || l.includes("│")) return true;
  }
  return false;
}

function stripCliInputChrome(lines) {
  // Goal: return the "conversation/log" portion and remove the interactive input box and autosuggest.
  // This reduces noise for both full captures and delta captures.
  const out = [...lines];

  // Prefer cutting at the UI delimiter (horizontal rule of box drawing chars),
  // but only when it really looks like a CLI input area below.
  const delimiterRe = /^[─━]{20,}\s*$/;
  const delimiterIdxs = [];
  for (let i = 0; i < out.length; i++) {
    if (delimiterRe.test(out[i])) delimiterIdxs.push(i);
  }
  const uiDelimiterIdxs = delimiterIdxs.filter((idx) =>
    looksLikeClaudeOrCodexInputChrome(out.slice(idx + 1))
  );
  if (uiDelimiterIdxs.length) {
    // Claude often has two horizontal rules; the last one can sit inside the input chrome.
    const cutIdx =
      uiDelimiterIdxs.length >= 2
        ? uiDelimiterIdxs[uiDelimiterIdxs.length - 2]
        : uiDelimiterIdxs[0];
    trimTrailingEmptyLines(out.splice(cutIdx));
    return trimTrailingEmptyLines(out);
  }

  // Fallback: cut before the last "❯" (Claude) or "›" (Codex) prompt line if present.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].trimStart().startsWith("❯") || out[i].trimStart().startsWith("›")) {
      out.splice(i);
      return trimTrailingEmptyLines(out);
    }
  }

  return trimTrailingEmptyLines(out);
}

async function captureTmuxPaneLines(target, { lines = DEFAULT_CAPTURE_LINES, mode = "filtered", joinWrapped = false } = {}) {
  const args = ["capture-pane", "-p", "-t", target, "-S", `-${lines}`, "-E", "-"];
  if (joinWrapped) args.splice(1, 0, "-J");
  const stdout = await tmux(args);
  const rawLines = trimTrailingEmptyLines(stdout.split("\n"));
  if (mode === "raw") return rawLines;
  return stripCliInputChrome(rawLines);
}

function findNewContentStart(lastContent, currentLines) {
  if (lastContent.length < MIN_MATCH_LINES) return -1;

  const anchorSize = Math.min(MIN_MATCH_LINES, lastContent.length);
  const anchor = lastContent.slice(-anchorSize);

  for (let i = currentLines.length - anchorSize; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < anchorSize; j++) {
      if (currentLines[i + j] !== anchor[j]) {
        match = false;
        break;
      }
    }
    if (match) return i + anchorSize;
  }
  return -1;
}

async function resolvePaneId(target) {
  const stdout = await tmux(["display-message", "-p", "-t", target, "#{pane_id}"]);
  return stdout.trim();
}

function agentLaunchCommand(agent, { continueSession, codexResumeId, includeMcpConfig, mcpConfigPath } = {}) {
  if (agent !== "claude" && agent !== "codex") throw new Error(`Invalid agent: ${agent}`);
  const parts = [];

  if (agent === "claude") {
    parts.push("claude", "--dangerously-skip-permissions");
    if (continueSession) parts.push("--continue");
  } else {
    // Codex does NOT support --continue. It uses "codex resume SESSION_ID".
    if (continueSession && codexResumeId) {
      parts.push("codex", "--dangerously-bypass-approvals-and-sandbox", "resume", codexResumeId);
    } else {
      parts.push("codex", "--dangerously-bypass-approvals-and-sandbox");
    }
  }

  if (includeMcpConfig && agent === "claude") {
    parts.push("--mcp-config", mcpConfigPath || "/home/ubuntu/.squad-mcp.json");
  }

  return parts.join(" ");
}

async function listPanesAll() {
  const fmt = [
    "#{pane_id}",
    "#{session_name}",
    "#{window_id}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_pid}",
    "#{pane_active}",
    "#{pane_current_command}",
    "#{pane_current_path}",
    "#{pane_title}",
  ].join(SEP);
  const out = await tmux(["list-panes", "-a", "-F", fmt]);
  const lines = out.trim() ? out.trim().split("\n") : [];
  return lines.map((l) => {
    const [
      paneId,
      sessionName,
      windowId,
      windowIndex,
      windowName,
      paneIndex,
      panePid,
      paneActive,
      currentCommand,
      currentPath,
      paneTitle,
    ] = l.split(SEP);
    return {
      paneId,
      sessionName,
      windowId,
      windowIndex: Number(windowIndex),
      windowName,
      paneIndex: Number(paneIndex),
      panePid: Number(panePid),
      paneActive: paneActive === "1",
      currentCommand,
      currentPath,
      paneTitle,
    };
  });
}

async function listAgents({ includeCaptain = false } = {}) {
  const panes = await listPanesAll();
  return panes
    .filter((p) => p.currentCommand === "claude" || p.currentCommand === "codex")
    .filter((p) => includeCaptain || !(p.sessionName === "captain" && p.windowIndex === 0))
    .map((p) => ({
      ...p,
      agent: p.currentCommand,
      role: p.sessionName === "captain" && p.windowIndex === 0 ? "captain" : "worker",
    }));
}

/**
 * Extract the codex resume session ID from pane output.
 * Codex prints "To continue this session, run codex resume SESSION_ID" on exit.
 * Returns the session ID string or null if not found.
 */
async function extractCodexResumeId(target) {
  try {
    const lines = await captureTmuxPaneLines(target, { lines: 100, mode: "raw" });
    // Look for "codex resume SESSION_ID" pattern (session IDs look like UUIDs or hex strings)
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/codex\s+resume\s+(\S+)/);
      if (m) return m[1];
    }
  } catch { /* pane may not exist yet */ }
  return null;
}

/**
 * Detect whether a codex agent is alive at its interactive input prompt.
 * When codex is idle, tmux may not report "codex" as pane_current_command,
 * causing list-workers to falsely report it as exited. This checks the raw
 * pane content for codex-specific UI markers: › prompt, "? for shortcuts",
 * and "XX% context left".
 */
async function detectCodexAlive(target) {
  try {
    const lines = await captureTmuxPaneLines(target, { lines: 30, mode: "raw" });
    const tail = lines.slice(-15);
    let hasPrompt = false;
    let hasShortcutsOrContext = false;
    for (const line of tail) {
      if (line.trimStart().startsWith("›")) hasPrompt = true;
      if (line.includes("? for shortcuts") || /\d+%\s*context left/.test(line)) hasShortcutsOrContext = true;
    }
    return hasPrompt && hasShortcutsOrContext;
  } catch {
    return false;
  }
}

async function restartAgentInPane(target, agent, opts) {
  const {
    continueSession = true,
    sourceEnv = true,
    ctrlCCount = 2,
    ctrlCDelayMs = 600,
    settleMs = 800,
    verify = true,
    verifyDelayMs = 2000,
    includeMcpConfig = false,
    mcpConfigPath = "/home/ubuntu/.squad-mcp.json",
  } = opts || {};

  const paneId = await resolvePaneId(target);

  // For codex, capture the resume session ID BEFORE killing the process.
  // Codex prints "codex resume SESSION_ID" when it exits, but it may also
  // be visible from a previous exit. Capture before AND after Ctrl-C.
  let codexResumeId = null;
  if (agent === "codex" && continueSession) {
    codexResumeId = await extractCodexResumeId(target);
  }

  for (let i = 0; i < ctrlCCount; i++) {
    await tmux(["send-keys", "-t", target, "C-c"]);
    await sleep(ctrlCDelayMs);
  }

  // Clear any partially typed line.
  await tmux(["send-keys", "-t", target, "C-u"]).catch(() => {});
  await sleep(settleMs);

  // For codex, try again after the process has exited (it may print the
  // resume ID as part of its shutdown message).
  if (agent === "codex" && continueSession && !codexResumeId) {
    codexResumeId = await extractCodexResumeId(target);
  }

  const launch = agentLaunchCommand(agent, { continueSession, codexResumeId, includeMcpConfig, mcpConfigPath });
  const fullCmd = sourceEnv
    ? `set -a; [ -f /home/ubuntu/env ] && . /home/ubuntu/env; set +a; ${launch}`
    : launch;

  await tmux(["send-keys", "-t", target, "-l", fullCmd]);
  await tmux(["send-keys", "-t", target, "Enter"]);

  if (!verify) return { paneId, launched: fullCmd, status: "unchecked", codexResumeId };

  await sleep(verifyDelayMs);
  const panes = await listPanesAll();
  const pane = panes.find((p) => p.paneId === paneId);
  const running = !!pane && pane.currentCommand === agent;

  if (!running) {
    return {
      paneId,
      launched: fullCmd,
      status: "failed",
      error: `Expected '${agent}' to be running but found '${pane?.currentCommand || "unknown"}'. The agent may have crashed on startup.`,
      currentCommand: pane?.currentCommand || null,
      codexResumeId,
    };
  }

  return {
    paneId,
    launched: fullCmd,
    status: "running",
    currentCommand: pane.currentCommand,
    codexResumeId,
  };
}

const server = new McpServer({ name: "squad", version: "1.0.0" });

// ---------------------------------------------------------------------------
// tmux wrappers
// ---------------------------------------------------------------------------

server.tool(
  "tmux-list-sessions",
  "List tmux sessions.",
  {},
  async () => {
    const fmt = [
      "#{session_name}",
      "#{session_id}",
      "#{session_windows}",
      "#{session_attached}",
      "#{session_path}",
    ].join(SEP);
    const out = await tmux(["list-sessions", "-F", fmt]).catch(() => "");
    const sessions = out.trim()
      ? out
          .trim()
          .split("\n")
          .map((l) => {
            const [name, id, windows, attached, path] = l.split(SEP);
            return { name, id, windows: Number(windows), attached: Number(attached), path };
          })
      : [];
    return { content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }] };
  }
);


server.tool(
  "tmux-list-windows",
  "List windows in a tmux session.",
  { session: z.string().min(1) },
  async ({ session }) => {
    const fmt = ["#{window_index}", "#{window_name}", "#{window_id}", "#{window_active}", "#{window_panes}"].join(SEP);
    const out = await tmux(["list-windows", "-t", session, "-F", fmt]).catch(() => "");
    const windows = out.trim()
      ? out
          .trim()
          .split("\n")
          .map((l) => {
            const [index, name, id, active, panes] = l.split(SEP);
            return { index: Number(index), name, id, active: active === "1", panes: Number(panes) };
          })
      : [];
    return { content: [{ type: "text", text: JSON.stringify({ windows }, null, 2) }] };
  }
);


server.tool(
  "tmux-list-panes",
  "List panes. Use target=... to list within a session/window, or omit to list all.",
  { target: z.string().optional() },
  async ({ target }) => {
    const panes = target ? await (async () => {
      const fmt = [
        "#{pane_id}",
        "#{session_name}",
        "#{window_id}",
        "#{window_index}",
        "#{window_name}",
        "#{pane_index}",
        "#{pane_pid}",
        "#{pane_active}",
        "#{pane_current_command}",
        "#{pane_current_path}",
        "#{pane_title}",
      ].join(SEP);
      const out = await tmux(["list-panes", "-t", target, "-F", fmt]).catch(() => "");
      const lines = out.trim() ? out.trim().split("\n") : [];
      return lines.map((l) => {
        const [
          paneId,
          sessionName,
          windowId,
          windowIndex,
          windowName,
          paneIndex,
          panePid,
          paneActive,
          currentCommand,
          currentPath,
          paneTitle,
        ] = l.split(SEP);
        return {
          paneId,
          sessionName,
          windowId,
          windowIndex: Number(windowIndex),
          windowName,
          paneIndex: Number(paneIndex),
          panePid: Number(panePid),
          paneActive: paneActive === "1",
          currentCommand,
          currentPath,
          paneTitle,
        };
      });
    })() : await listPanesAll();
    return { content: [{ type: "text", text: JSON.stringify({ panes }, null, 2) }] };
  }
);


// ---------------------------------------------------------------------------
// Worker interaction (safe abstractions — no raw text sending)
// ---------------------------------------------------------------------------

server.tool(
  "send-worker-command",
  "Send a command to a worker pane. Double-Enter with delays ensures submission even with bracketed paste mode. WARNING: For Codex workers, sending commands to a RUNNING agent (e.g. Escape + new text) will kill the in-progress session. Only use this on idle shell prompts or stopped workers. To give a Codex worker a new task, stop it first, then start a new one.",
  {
    target: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'myproject:worker1')"),
    command: z.string().min(1).describe("The command string to send"),
  },
  async ({ target, command }) => {
    await tmux(["send-keys", "-t", target, "-l", command]);
    await sleep(500);
    await tmux(["send-keys", "-t", target, "Enter"]);
    await sleep(500);
    await tmux(["send-keys", "-t", target, "Enter"]);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, target, command }, null, 2) }] };
  }
);

server.tool(
  "send-worker-key",
  "Send a SINGLE key to a worker pane. Used for interacting with menus, confirmations, and control sequences. Only one key per call. WARNING: For Codex workers, sending Escape or arbitrary keys to a RUNNING agent will destroy the in-progress session. Only safe keys for running Codex are 'C-c' (to stop it). Use 'y'/'n'/Enter only when Codex is showing a confirmation prompt.",
  {
    target: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'myproject:worker1')"),
    key: z.string().min(1).describe("A single tmux key (e.g. 'C-c', 'Enter', 'y', 'n', 'Up', 'Down', 'q')"),
  },
  async ({ target, key }) => {
    await tmux(["send-keys", "-t", target, key]);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, target, key }, null, 2) }] };
  }
);

server.tool(
  "kill-worker",
  "Kill a worker's tmux window.",
  {
    target: z.string().min(1).describe("tmux pane ID or session:window target (e.g. '%3' or 'myproject:worker1')"),
  },
  async ({ target }) => {
    await tmux(["kill-window", "-t", target]);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, target }, null, 2) }] };
  }
);

server.tool(
  "start-worker",
  "Start a new worker agent in a project session. Creates a new tmux window and launches a Claude or Codex agent with the given prompt.",
  {
    project_name: z.string().min(1).describe("tmux session name (must already exist — use create-project-session first)"),
    task_name: z.string().min(1).describe("Window name for this worker (used as tmux window name)"),
    tool: z.enum(["claude", "codex"]).describe("Which agent CLI to launch"),
    prompt: z.string().min(1).describe("The task description / prompt to give the agent"),
    cwd: z.string().optional().describe("Working directory for the worker window. Defaults to the project session's working directory."),
  },
  async ({ project_name, task_name, tool, prompt, cwd }) => {
    // Verify session exists
    if (!(await tmuxOk(["has-session", "-t", project_name]))) {
      return {
        content: [{ type: "text", text: `Error: tmux session '${project_name}' does not exist. Use create-project-session first.` }],
        isError: true,
      };
    }

    // Resolve working directory: use explicit cwd, or fall back to session's working directory
    let workDir = cwd;
    if (!workDir) {
      try {
        const sessionPath = await tmux(["display-message", "-p", "-t", project_name, "#{session_path}"]);
        workDir = sessionPath.trim();
      } catch {
        // Could not determine session path; new-window will inherit tmux defaults
      }
    }

    // Create a new window in the session
    const newWindowArgs = ["new-window", "-t", project_name, "-n", task_name];
    if (workDir) {
      newWindowArgs.push("-c", workDir);
    }
    newWindowArgs.push("-P", "-F", `#{window_id}${SEP}#{pane_id}`);
    const winOut = await tmux(newWindowArgs);
    const [windowId, paneId] = winOut.trim().split(SEP);

    // Build the launch command
    const agentCmd = tool === "claude"
      ? `claude --dangerously-skip-permissions`
      : `codex --dangerously-bypass-approvals-and-sandbox`;

    // Escape single quotes in prompt for shell safety
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const fullCmd = `set -a; [ -f /home/ubuntu/env ] && . /home/ubuntu/env; set +a; ${agentCmd} '${escapedPrompt}'`;

    // Send the command with double-Enter for bracketed paste safety
    await tmux(["send-keys", "-t", paneId, "-l", fullCmd]);
    await sleep(500);
    await tmux(["send-keys", "-t", paneId, "Enter"]);
    await sleep(500);
    await tmux(["send-keys", "-t", paneId, "Enter"]);

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, project_name, task_name, tool, windowId, paneId }, null, 2) }],
    };
  }
);

server.tool(
  "create-project-session",
  "Create a new tmux session for a project. Use this before start-worker to set up the project workspace.",
  {
    project_name: z.string().min(1).describe("Session name (e.g. 'myproject')"),
    path: z.string().optional().describe("Working directory (defaults to /home/ubuntu/<project_name>)"),
  },
  async ({ project_name, path }) => {
    const cwd = path || `/home/ubuntu/${project_name}`;

    // Kill existing session if it exists
    await tmux(["kill-session", "-t", project_name]).catch(() => {});

    const out = await tmux([
      "new-session", "-d", "-s", project_name, "-c", cwd,
      "-P", "-F", ["#{session_name}", "#{session_id}", "#{window_id}", "#{pane_id}"].join(SEP),
    ]);
    const [name, id, windowId, paneId] = out.trim().split(SEP);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, name, id, windowId, paneId, cwd }, null, 2) }],
    };
  }
);

server.tool(
  "stop-worker",
  "Gracefully stop a worker agent (sends Ctrl-C sequence) without killing the tmux window. Useful when you want to stop the agent but keep the shell for inspection.",
  {
    target: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'myproject:worker1')"),
    ctrlCCount: z.number().int().min(1).max(5).default(2),
    ctrlCDelayMs: z.number().int().min(100).max(5000).default(600),
  },
  async ({ target, ctrlCCount, ctrlCDelayMs }) => {
    for (let i = 0; i < ctrlCCount; i++) {
      await tmux(["send-keys", "-t", target, "C-c"]);
      await sleep(ctrlCDelayMs);
    }
    // Clear any leftover input
    await tmux(["send-keys", "-t", target, "C-u"]).catch(() => {});
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, target, ctrlCCount }, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Read-only tmux tools
// ---------------------------------------------------------------------------

server.tool(
  "capture-pane",
  "Capture tmux pane output. By default, filters out interactive input chrome (Claude/Codex input box + autosuggest).",
  {
    target: z.string().min(1),
    lines: z.number().int().min(1).max(4000).default(500),
    mode: z.enum(["filtered", "raw"]).default("filtered"),
    joinWrapped: z.boolean().default(false),
  },
  async ({ target, lines, mode, joinWrapped }) => {
    const captured = await captureTmuxPaneLines(target, { lines, mode, joinWrapped });
    return { content: [{ type: "text", text: captured.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Delta capture
// ---------------------------------------------------------------------------

server.tool(
  "capture-pane-delta",
  "Capture only NEW tmux pane output since the last check (per pane + mode). Default mode is filtered to ignore Claude/Codex input chrome that constantly changes. Output is capped to maxLines (default 40) most-recent lines; set maxLines higher if you need more.",
  {
    paneId: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'captain:0')"),
    overlap: z.number().int().min(0).max(50).default(5),
    reset: z.boolean().default(false),
    mode: z.enum(["filtered", "raw"]).default("filtered"),
    maxLines: z.number().int().min(1).max(4000).default(40).describe("Max lines to return (keeps most recent). Increase if you need more context."),
  },
  async ({ paneId, overlap = 5, reset = false, mode = "filtered", maxLines = 40 }) => {
    const resolvedPaneId = paneId.startsWith("%") ? paneId : await resolvePaneId(paneId);
    const stateKey = `${resolvedPaneId}|${mode}`;

    let currentLines;
    try {
      currentLines = await captureTmuxPaneLines(resolvedPaneId, { lines: DEFAULT_CAPTURE_LINES, mode });
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error capturing pane ${paneId}: ${err.message}` }],
        isError: true,
      };
    }

    // Truncate an array of lines to at most maxLines, keeping the most recent (bottom).
    function truncate(lines) {
      if (lines.length <= maxLines) return lines.join("\n");
      const omitted = lines.length - maxLines;
      return `[truncated — ${omitted} lines omitted, use maxLines param for more]\n${lines.slice(-maxLines).join("\n")}`;
    }

    if (reset) {
      paneState.set(stateKey, {
        lastContent: currentLines,
        lastCaptureTime: Date.now(),
      });
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | ${currentLines.length} lines | reset: true]\n${truncate(currentLines)}` }] };
    }

    const state = paneState.get(stateKey);
    if (!state) {
      paneState.set(stateKey, { lastContent: currentLines, lastCaptureTime: Date.now() });
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | ${currentLines.length} lines | first check: true]\n${truncate(currentLines)}` }] };
    }

    // Strip the last INPUT_BOX_STRIP_LINES from both captures before diffing.
    // Claude Code / Codex workers have a constantly-changing input box and
    // autocomplete area at the bottom of their pane. Including those lines in
    // the comparison causes the suffix-anchor to never match, producing a
    // false "gap detected" on every call. Stripping is only for the
    // comparison — the actual returned output uses the full capture.
    const INPUT_BOX_STRIP_LINES = 10;
    const currentForCompare = currentLines.length > INPUT_BOX_STRIP_LINES
      ? currentLines.slice(0, -INPUT_BOX_STRIP_LINES)
      : currentLines;
    const previousForCompare = state.lastContent.length > INPUT_BOX_STRIP_LINES
      ? state.lastContent.slice(0, -INPUT_BOX_STRIP_LINES)
      : state.lastContent;

    if (
      currentForCompare.length === previousForCompare.length &&
      currentForCompare.join("\n") === previousForCompare.join("\n")
    ) {
      state.lastCaptureTime = Date.now();
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | no new output]` }] };
    }

    const newStart = findNewContentStart(previousForCompare, currentForCompare);
    let resultLines;
    let header;

    if (newStart === -1) {
      resultLines = currentLines;
      header = `[pane ${resolvedPaneId} | ${currentLines.length} lines | gap detected — showing full capture]`;
    } else if (newStart >= currentForCompare.length) {
      state.lastContent = currentLines;
      state.lastCaptureTime = Date.now();
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | no new output]` }] };
    } else {
      const overlapStart = Math.max(0, newStart - overlap);
      resultLines = currentLines.slice(overlapStart);
      const newCount = currentLines.length - newStart;
      const overlapCount = newStart - overlapStart;
      header = `[pane ${resolvedPaneId} | ${newCount} new lines | ${overlapCount} overlap | first check: false]`;
    }

    state.lastContent = currentLines;
    state.lastCaptureTime = Date.now();

    return { content: [{ type: "text", text: `${header}\n${truncate(resultLines)}` }] };
  }
);

// ---------------------------------------------------------------------------
// Agent management
// ---------------------------------------------------------------------------

server.tool(
  "list-agents",
  "List running Claude/Codex panes (workers and optionally the captain).",
  { includeCaptain: z.boolean().default(false) },
  async ({ includeCaptain }) => {
    const agents = await listAgents({ includeCaptain });
    return { content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }] };
  }
);

server.tool(
  "list-workers",
  "List all worker panes across all project sessions with their status. Shows project (session), task (window name), agent type, working directory, and whether the agent is still running or has exited to a shell.",
  {},
  async () => {
    const panes = await listPanesAll();
    // Exclude the captain session window 0 (that's the captain itself)
    const filtered = panes
      .filter((p) => !(p.sessionName === "captain" && p.windowIndex === 0))
      .filter((p) => p.sessionName !== "captain" || p.windowIndex !== 1); // also exclude voice window
    const workers = await Promise.all(filtered.map(async (p) => {
      const isAgent = p.currentCommand === "claude" || p.currentCommand === "codex";
      let agent = isAgent ? p.currentCommand : null;
      let status = isAgent ? "running" : "exited";
      // When tmux doesn't report codex as the foreground command (e.g. codex
      // is idle at its input prompt), check the raw pane content for codex UI.
      if (!isAgent) {
        const codexAlive = await detectCodexAlive(p.paneId);
        if (codexAlive) {
          agent = "codex";
          status = "running";
        }
      }
      return {
        target: p.paneId,
        project: p.sessionName,
        task: p.windowName,
        agent,
        status,
        currentCommand: p.currentCommand,
        cwd: p.currentPath,
      };
    }));
    return { content: [{ type: "text", text: JSON.stringify({ workers }, null, 2) }] };
  }
);

server.tool(
  "check-worker-status",
  "Check the status of a specific worker pane. Returns whether the agent is running, exited to shell, or the pane no longer exists. For exited codex workers, attempts to find the resume session ID.",
  {
    target: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'myproject:worker1')"),
  },
  async ({ target }) => {
    let paneId;
    try {
      paneId = await resolvePaneId(target);
    } catch {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "not_found", target, error: "Pane does not exist" }, null, 2) }],
      };
    }

    const panes = await listPanesAll();
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "not_found", target, paneId }, null, 2) }],
      };
    }

    const isAgent = pane.currentCommand === "claude" || pane.currentCommand === "codex";
    let detectedAgent = isAgent ? pane.currentCommand : null;
    let detectedStatus = isAgent ? "running" : "exited";

    // When tmux doesn't report codex as the foreground command (e.g. codex
    // is idle at its input prompt), check the raw pane content for codex UI.
    if (!isAgent) {
      const codexAlive = await detectCodexAlive(paneId);
      if (codexAlive) {
        detectedAgent = "codex";
        detectedStatus = "running";
      }
    }

    const result = {
      status: detectedStatus,
      target,
      paneId,
      agent: detectedAgent,
      currentCommand: pane.currentCommand,
      project: pane.sessionName,
      task: pane.windowName,
      cwd: pane.currentPath,
    };

    // For truly exited workers, look for codex resume ID
    if (detectedStatus === "exited") {
      const resumeId = await extractCodexResumeId(paneId);
      if (resumeId) result.codexResumeId = resumeId;
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "restart-pane-agent",
  "Restart a single pane as a Claude or Codex agent (Ctrl-C sequence + relaunch). For Claude, uses --continue. For Codex, captures the resume session ID and uses 'codex resume SESSION_ID'.",
  {
    target: z.string().min(1).describe("tmux target (pane id like %3, or target like session:window)"),
    agent: z.enum(["claude", "codex"]),
    continueSession: z.boolean().default(true),
    sourceEnv: z.boolean().default(true),
    ctrlCCount: z.number().int().min(1).max(5).default(2),
    ctrlCDelayMs: z.number().int().min(100).max(5000).default(600),
    settleMs: z.number().int().min(0).max(5000).default(800),
    verify: z.boolean().default(true),
    verifyDelayMs: z.number().int().min(0).max(20000).default(2000),
  },
  async (args) => {
    const res = await restartAgentInPane(args.target, args.agent, args);
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: res.status === "failed",
    };
  }
);

server.tool(
  "restart-workers",
  "Restart all running workers (sequentially) for a given agent type (or both). This avoids --continue cross-contamination by not restarting in parallel.",
  {
    agent: z.enum(["claude", "codex", "all"]).default("all"),
    continueSession: z.boolean().default(true),
    sourceEnv: z.boolean().default(true),
    stopOnFailure: z.boolean().default(true),
    ctrlCCount: z.number().int().min(1).max(5).default(2),
    ctrlCDelayMs: z.number().int().min(100).max(5000).default(600),
    settleMs: z.number().int().min(0).max(5000).default(800),
    verifyDelayMs: z.number().int().min(0).max(20000).default(2000),
  },
  async (args) => {
    const agents = await listAgents({ includeCaptain: false });
    const targets = agents.filter((a) => args.agent === "all" || a.agent === args.agent);

    const results = [];
    for (const a of targets) {
      const r = await restartAgentInPane(a.paneId, a.agent, {
        continueSession: args.continueSession,
        sourceEnv: args.sourceEnv,
        ctrlCCount: args.ctrlCCount,
        ctrlCDelayMs: args.ctrlCDelayMs,
        settleMs: args.settleMs,
        verify: true,
        verifyDelayMs: args.verifyDelayMs,
      });
      results.push({ target: a.paneId, sessionName: a.sessionName, windowName: a.windowName, agent: a.agent, result: r });
      if (r.status === "failed" && args.stopOnFailure) {
        return { content: [{ type: "text", text: JSON.stringify({ restarted: results.length, results }, null, 2) }], isError: true };
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ restarted: results.length, results }, null, 2) }] };
  }
);

server.tool(
  "restart-captain",
  "Restart the captain pane (captain:0) as Claude or Codex. For Claude captains, injects --mcp-config so the new captain can reconnect.",
  {
    agent: z.enum(["claude", "codex"]),
    continueSession: z.boolean().default(true),
    sourceEnv: z.boolean().default(true),
    ctrlCCount: z.number().int().min(1).max(5).default(2),
    ctrlCDelayMs: z.number().int().min(100).max(5000).default(600),
    settleMs: z.number().int().min(0).max(5000).default(800),
    verifyDelayMs: z.number().int().min(0).max(20000).default(2500),
  },
  async (args) => {
    // Ensure the tmux session exists.
    if (!(await tmuxOk(["has-session", "-t", "captain"]))) {
      await tmux(["new-session", "-d", "-s", "captain", "-c", "/home/ubuntu/captain"]);
    }

    const res = await restartAgentInPane("captain:0", args.agent, {
      ...args,
      includeMcpConfig: args.agent === "claude",
      mcpConfigPath: "/home/ubuntu/.squad-mcp.json",
      verify: false, // restarting the client itself can break the MCP connection; don't hard-fail on verification
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
