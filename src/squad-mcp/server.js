#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CAPTURE_LINES = 500;
const MIN_MATCH_LINES = 3; // suffix matching anchor size

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
  // We only strip below delimiter if we see an interactive prompt beneath it.
  for (let i = 0; i < Math.min(60, linesAfterDelimiter.length); i++) {
    const l = linesAfterDelimiter[i] ?? "";
    if (l.trimStart().startsWith("❯")) return true;
    if (l.includes("Ctrl") && l.includes("Enter")) return true;
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

  // Fallback: cut before the last "❯" prompt line if present.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].trimStart().startsWith("❯")) {
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

function agentLaunchCommand(agent, { continueSession, includeMcpConfig, mcpConfigPath } = {}) {
  if (agent !== "claude" && agent !== "codex") throw new Error(`Invalid agent: ${agent}`);
  const parts = [];
  if (agent === "claude") parts.push("claude", "--dangerously-skip-permissions");
  else parts.push("codex", "--dangerously-bypass-approvals-and-sandbox");

  if (continueSession) parts.push("--continue");

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
  ].join("\t");
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
    ] = l.split("\t");
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

  for (let i = 0; i < ctrlCCount; i++) {
    await tmux(["send-keys", "-t", target, "C-c"]);
    await sleep(ctrlCDelayMs);
  }

  // Clear any partially typed line.
  await tmux(["send-keys", "-t", target, "C-u"]).catch(() => {});
  await sleep(settleMs);

  const launch = agentLaunchCommand(agent, { continueSession, includeMcpConfig, mcpConfigPath });
  const fullCmd = sourceEnv
    ? `set -a; [ -f /home/ubuntu/env ] && . /home/ubuntu/env; set +a; ${launch}`
    : launch;

  await tmux(["send-keys", "-t", target, "-l", fullCmd]);
  await tmux(["send-keys", "-t", target, "Enter"]);

  if (!verify) return { paneId, launched: fullCmd, verified: false };

  await sleep(verifyDelayMs);
  const panes = await listPanesAll();
  const pane = panes.find((p) => p.paneId === paneId);
  const ok = !!pane && pane.currentCommand === agent;
  return {
    paneId,
    launched: fullCmd,
    verified: true,
    currentCommand: pane?.currentCommand || null,
    ok,
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
    ].join("\t");
    const out = await tmux(["list-sessions", "-F", fmt]).catch(() => "");
    const sessions = out.trim()
      ? out
          .trim()
          .split("\n")
          .map((l) => {
            const [name, id, windows, attached, path] = l.split("\t");
            return { name, id, windows: Number(windows), attached: Number(attached), path };
          })
      : [];
    return { content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }] };
  }
);

server.tool(
  "tmux-new-session",
  "Create a new tmux session (detached by default).",
  {
    sessionName: z.string().min(1),
    cwd: z.string().optional(),
    killIfExists: z.boolean().default(false),
  },
  async ({ sessionName, cwd, killIfExists }) => {
    if (killIfExists) await tmux(["kill-session", "-t", sessionName]).catch(() => {});
    const args = ["new-session", "-d", "-s", sessionName, "-P", "-F", "#{session_name}\t#{session_id}\t#{window_id}\t#{pane_id}"];
    if (cwd) args.splice(5, 0, "-c", cwd);
    const out = await tmux(args);
    const [name, id, windowId, paneId] = out.trim().split("\t");
    return { content: [{ type: "text", text: JSON.stringify({ name, id, windowId, paneId }, null, 2) }] };
  }
);

server.tool(
  "tmux-kill-session",
  "Kill a tmux session.",
  { sessionName: z.string().min(1) },
  async ({ sessionName }) => {
    await tmux(["kill-session", "-t", sessionName]);
    return { content: [{ type: "text", text: "ok" }] };
  }
);

server.tool(
  "tmux-list-windows",
  "List windows in a tmux session.",
  { session: z.string().min(1) },
  async ({ session }) => {
    const fmt = ["#{window_index}", "#{window_name}", "#{window_id}", "#{window_active}", "#{window_panes}"].join("\t");
    const out = await tmux(["list-windows", "-t", session, "-F", fmt]).catch(() => "");
    const windows = out.trim()
      ? out
          .trim()
          .split("\n")
          .map((l) => {
            const [index, name, id, active, panes] = l.split("\t");
            return { index: Number(index), name, id, active: active === "1", panes: Number(panes) };
          })
      : [];
    return { content: [{ type: "text", text: JSON.stringify({ windows }, null, 2) }] };
  }
);

server.tool(
  "tmux-new-window",
  "Create a new tmux window in a session.",
  {
    session: z.string().min(1),
    windowName: z.string().min(1),
    cwd: z.string().optional(),
  },
  async ({ session, windowName, cwd }) => {
    const args = ["new-window", "-t", session, "-n", windowName, "-P", "-F", "#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}"];
    if (cwd) args.splice(5, 0, "-c", cwd);
    const out = await tmux(args);
    const [windowId, windowIndex, name, paneId] = out.trim().split("\t");
    return {
      content: [{ type: "text", text: JSON.stringify({ windowId, windowIndex: Number(windowIndex), name, paneId }, null, 2) }],
    };
  }
);

server.tool(
  "tmux-kill-window",
  "Kill a tmux window.",
  { target: z.string().min(1) },
  async ({ target }) => {
    await tmux(["kill-window", "-t", target]);
    return { content: [{ type: "text", text: "ok" }] };
  }
);

server.tool(
  "tmux-split-pane",
  "Split a tmux pane (creates a new pane).",
  {
    target: z.string().min(1),
    direction: z.enum(["horizontal", "vertical"]).default("vertical"),
    sizePercent: z.number().int().min(10).max(90).optional(),
    cwd: z.string().optional(),
  },
  async ({ target, direction, sizePercent, cwd }) => {
    const args = ["split-window", "-t", target, direction === "horizontal" ? "-h" : "-v", "-P", "-F", "#{pane_id}"];
    if (typeof sizePercent === "number") args.splice(4, 0, "-p", String(sizePercent));
    if (cwd) args.splice(4, 0, "-c", cwd);
    const out = await tmux(args);
    return { content: [{ type: "text", text: JSON.stringify({ paneId: out.trim() }, null, 2) }] };
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
      ].join("\t");
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
        ] = l.split("\t");
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

server.tool(
  "tmux-send-keys",
  "Send keys to a tmux target. Prefer tmux-send-command for typical command submission.",
  {
    target: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
  },
  async ({ target, keys }) => {
    await tmux(["send-keys", "-t", target, ...keys]);
    return { content: [{ type: "text", text: "ok" }] };
  }
);

server.tool(
  "tmux-send-command",
  "Send a literal command line to a tmux target and press Enter (optionally multiple times). Includes a small delay before Enter to avoid bracketed-paste swallowing the submission in some CLIs.",
  {
    target: z.string().min(1),
    command: z.string(),
    enterCount: z.number().int().min(0).max(3).default(1),
    delayBeforeEnterMs: z.number().int().min(0).max(5000).default(400),
  },
  async ({ target, command, enterCount, delayBeforeEnterMs }) => {
    await tmux(["send-keys", "-t", target, "-l", command]);
    if (enterCount > 0) await sleep(delayBeforeEnterMs);
    for (let i = 0; i < enterCount; i++) await tmux(["send-keys", "-t", target, "Enter"]);
    return { content: [{ type: "text", text: "ok" }] };
  }
);

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
  "Capture only NEW tmux pane output since the last check (per pane + mode). Default mode is filtered to ignore Claude/Codex input chrome that constantly changes.",
  {
    paneId: z.string().min(1).describe("tmux pane ID or target (e.g. '%3' or 'captain:0')"),
    overlap: z.number().int().min(0).max(50).default(5),
    reset: z.boolean().default(false),
    mode: z.enum(["filtered", "raw"]).default("filtered"),
  },
  async ({ paneId, overlap = 5, reset = false, mode = "filtered" }) => {
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

    if (reset) {
      paneState.set(stateKey, {
        lastContent: currentLines,
        lastCaptureTime: Date.now(),
      });
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | ${currentLines.length} lines | reset: true]\n${currentLines.join("\n")}` }] };
    }

    const state = paneState.get(stateKey);
    if (!state) {
      paneState.set(stateKey, { lastContent: currentLines, lastCaptureTime: Date.now() });
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | ${currentLines.length} lines | first check: true]\n${currentLines.join("\n")}` }] };
    }

    if (
      currentLines.length === state.lastContent.length &&
      currentLines.join("\n") === state.lastContent.join("\n")
    ) {
      state.lastCaptureTime = Date.now();
      return { content: [{ type: "text", text: `[pane ${resolvedPaneId} | no new output]` }] };
    }

    const newStart = findNewContentStart(state.lastContent, currentLines);
    let resultLines;
    let header;

    if (newStart === -1) {
      resultLines = currentLines;
      header = `[pane ${resolvedPaneId} | ${currentLines.length} lines | gap detected — showing full capture]`;
    } else if (newStart >= currentLines.length) {
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

    return { content: [{ type: "text", text: `${header}\n${resultLines.join("\n")}` }] };
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
  "restart-pane-agent",
  "Restart a single pane as a Claude or Codex agent (Ctrl-C sequence + relaunch). Uses --continue by default.",
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
    if (res.verified && !res.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
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
      if (r.verified && !r.ok && args.stopOnFailure) {
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
