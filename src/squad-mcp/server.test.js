#!/usr/bin/env node

// Tests for squad MCP server tool definitions.
// Validates that the safe worker abstractions exist and the removed
// low-level tools are no longer registered.
//
// Uses the MCP SDK's in-memory transport so we can inspect tools
// without a real tmux.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// We can't import server.js directly (it auto-connects to stdio transport),
// so we replicate tool registration checks by importing it as a child process
// and talking over MCP. But that requires tmux. Instead, we'll parse the
// server.js source and check for tool registrations.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = await readFile(join(__dirname, "server.js"), "utf8");

// Extract all server.tool("name", ...) registrations
const toolNames = [...source.matchAll(/server\.tool\(\s*"([^"]+)"/g)].map(m => m[1]);

console.log("\n=== Tool Registration Tests ===\n");
console.log(`Found ${toolNames.length} registered tools: ${toolNames.join(", ")}\n`);

// --- Removed tools should NOT exist ---
const removedTools = [
  "tmux-send-keys",
  "tmux-send-command",
  "tmux-split-pane",
  "tmux-new-window",
  "tmux-kill-window",
  "tmux-new-session",
  "tmux-kill-session",
];

console.log("-- Removed tools (should NOT be present) --");
for (const name of removedTools) {
  assert(!toolNames.includes(name), `"${name}" is NOT registered`);
}

// --- Kept read-only/management tools should exist ---
const keptTools = [
  "tmux-list-sessions",
  "tmux-list-windows",
  "tmux-list-panes",
  "capture-pane",
  "capture-pane-delta",
  "list-agents",
  "restart-pane-agent",
  "restart-workers",
  "restart-captain",
];

console.log("\n-- Kept tools (should be present) --");
for (const name of keptTools) {
  assert(toolNames.includes(name), `"${name}" IS registered`);
}

// --- New safe worker tools should exist ---
const newTools = [
  "send-worker-command",
  "send-worker-key",
  "kill-worker",
  "start-worker",
  "create-project-session",
  "stop-worker",
  "list-workers",
  "check-worker-status",
];

console.log("\n-- New tools (should be present) --");
for (const name of newTools) {
  assert(toolNames.includes(name), `"${name}" IS registered`);
}

// --- Validate tool implementations via source inspection ---
console.log("\n=== Implementation Validation ===\n");

// send-worker-command should use -l (literal) and double Enter
const sendWorkerCmdMatch = source.match(/server\.tool\(\s*"send-worker-command"[\s\S]*?(?=server\.tool\()/);
if (sendWorkerCmdMatch) {
  const impl = sendWorkerCmdMatch[0];
  assert(impl.includes('"-l"'), "send-worker-command uses -l flag for literal text");
  assert((impl.match(/"Enter"/g) || []).length >= 2, "send-worker-command sends Enter at least twice");
  assert(impl.includes("sleep"), "send-worker-command includes delays between sends");
} else {
  assert(false, "send-worker-command implementation found");
}

// send-worker-key should NOT use -l (sends raw key, not literal text)
const sendWorkerKeyMatch = source.match(/server\.tool\(\s*"send-worker-key"[\s\S]*?(?=server\.tool\()/);
if (sendWorkerKeyMatch) {
  const impl = sendWorkerKeyMatch[0];
  assert(!impl.includes('"-l"'), "send-worker-key does NOT use -l flag (sends raw key)");
  // Should only send one key
  assert((impl.match(/send-keys/g) || []).length === 1, "send-worker-key calls send-keys exactly once");
} else {
  assert(false, "send-worker-key implementation found");
}

// start-worker should source env, create window, and launch agent
const startWorkerMatch = source.match(/server\.tool\(\s*"start-worker"[\s\S]*?(?=server\.tool\()/);
if (startWorkerMatch) {
  const impl = startWorkerMatch[0];
  assert(impl.includes("has-session"), "start-worker verifies session exists");
  assert(impl.includes("new-window"), "start-worker creates a new tmux window");
  assert(impl.includes("/home/ubuntu/env"), "start-worker sources env file");
  assert(impl.includes("dangerously-skip-permissions"), "start-worker uses --dangerously-skip-permissions for claude");
  assert(impl.includes("dangerously-bypass-approvals-and-sandbox"), "start-worker uses --dangerously-bypass-approvals-and-sandbox for codex");
  assert(impl.includes("prompt"), "start-worker passes the prompt to the agent");

  // --- cwd parameter tests ---
  assert(impl.includes("cwd"), "start-worker schema includes cwd parameter");
  assert(impl.includes(".optional()"), "start-worker cwd parameter is optional");
  assert(impl.includes('"-c"') || impl.includes('"-c",'), "start-worker passes -c flag to new-window for working directory");
  assert(impl.includes("session_path"), "start-worker falls back to session_path when cwd is omitted");
  assert(impl.includes("display-message"), "start-worker uses display-message to look up session_path");
} else {
  assert(false, "start-worker implementation found");
}

// create-project-session should create a session with a working directory
const createProjMatch = source.match(/server\.tool\(\s*"create-project-session"[\s\S]*?(?=server\.tool\()/);
if (createProjMatch) {
  const impl = createProjMatch[0];
  assert(impl.includes("new-session"), "create-project-session creates a tmux session");
  assert(impl.includes("/home/ubuntu/"), "create-project-session defaults to /home/ubuntu/<name>");
} else {
  assert(false, "create-project-session implementation found");
}

// kill-worker should use kill-window
const killWorkerMatch = source.match(/server\.tool\(\s*"kill-worker"[\s\S]*?(?=server\.tool\()/);
if (killWorkerMatch) {
  const impl = killWorkerMatch[0];
  assert(impl.includes("kill-window"), "kill-worker uses tmux kill-window");
} else {
  assert(false, "kill-worker implementation found");
}

// stop-worker should use Ctrl-C and clear input
const stopWorkerMatch = source.match(/server\.tool\(\s*"stop-worker"[\s\S]*?(?=server\.tool\()/);
if (stopWorkerMatch) {
  const impl = stopWorkerMatch[0];
  assert(impl.includes("C-c"), "stop-worker sends Ctrl-C");
  assert(impl.includes("C-u"), "stop-worker clears leftover input with Ctrl-U");
} else {
  assert(false, "stop-worker implementation found");
}

// --- Verify restartAgentInPane uses direct tmux calls, not removed tool handlers ---
console.log("\n=== Internal Implementation Safety ===\n");
const restartMatch = source.match(/async function restartAgentInPane[\s\S]*?^}/m);
if (restartMatch) {
  const impl = restartMatch[0];
  assert(impl.includes('tmux(["send-keys"'), "restartAgentInPane uses tmux() directly, not removed tools");
  assert(!impl.includes("server.tool"), "restartAgentInPane does not reference server.tool");
} else {
  assert(false, "restartAgentInPane implementation found");
}

// --- Verify codex resume support ---
console.log("\n=== Codex Resume Support ===\n");

// agentLaunchCommand should handle codex resume
const agentLaunchMatch = source.match(/function agentLaunchCommand[\s\S]*?^}/m);
if (agentLaunchMatch) {
  const impl = agentLaunchMatch[0];
  assert(impl.includes("codexResumeId"), "agentLaunchCommand accepts codexResumeId parameter");
  assert(impl.includes('"resume"'), "agentLaunchCommand uses 'resume' subcommand for codex");
  assert(!impl.includes('parts.push("codex"') || !impl.match(/codex.*--continue/), "agentLaunchCommand does NOT use --continue for codex");
} else {
  assert(false, "agentLaunchCommand implementation found");
}

// extractCodexResumeId should exist
assert(source.includes("async function extractCodexResumeId"), "extractCodexResumeId function exists");
assert(source.includes("codex\\s+resume\\s+") || source.includes("codex\\\\s+resume"), "extractCodexResumeId looks for 'codex resume SESSION_ID' pattern");

// restartAgentInPane should use extractCodexResumeId for codex
if (restartMatch) {
  const impl = restartMatch[0];
  assert(impl.includes("extractCodexResumeId"), "restartAgentInPane calls extractCodexResumeId for codex");
  assert(impl.includes("codexResumeId"), "restartAgentInPane passes codexResumeId to agentLaunchCommand");
}

// --- Verify return value format uses status instead of ok/verified ---
console.log("\n=== Return Value Format ===\n");
if (restartMatch) {
  const impl = restartMatch[0];
  assert(impl.includes('"running"'), "restartAgentInPane returns status: 'running' on success");
  assert(impl.includes('"failed"'), "restartAgentInPane returns status: 'failed' on failure");
  assert(impl.includes('"unchecked"'), "restartAgentInPane returns status: 'unchecked' when verify=false");
  assert(!impl.includes('"ok"') || !impl.includes('ok:'), "restartAgentInPane does NOT use old 'ok' field");
  assert(impl.includes("error:") || impl.includes('"error"'), "restartAgentInPane includes error message on failure");
}

// restart-pane-agent handler should check status === "failed"
const restartPaneAgentMatch = source.match(/server\.tool\(\s*"restart-pane-agent"[\s\S]*?(?=server\.tool\()/);
if (restartPaneAgentMatch) {
  const impl = restartPaneAgentMatch[0];
  assert(impl.includes('"failed"'), "restart-pane-agent checks status === 'failed'");
  assert(!impl.includes("r.verified"), "restart-pane-agent does NOT use old r.verified check");
}

// --- Verify safety warnings in tool descriptions ---
console.log("\n=== Codex Safety Warnings ===\n");
const sendCmdMatch2 = source.match(/server\.tool\(\s*"send-worker-command"[\s\S]*?(?=server\.tool\()/);
if (sendCmdMatch2) {
  const impl = sendCmdMatch2[0];
  assert(impl.includes("WARNING") || impl.includes("Codex"), "send-worker-command includes codex safety warning");
}
const sendKeyMatch2 = source.match(/server\.tool\(\s*"send-worker-key"[\s\S]*?(?=server\.tool\()/);
if (sendKeyMatch2) {
  const impl = sendKeyMatch2[0];
  assert(impl.includes("WARNING") || impl.includes("Codex"), "send-worker-key includes codex safety warning");
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
