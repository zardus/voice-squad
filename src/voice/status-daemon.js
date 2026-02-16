const { execFile } = require("child_process");

const POLL_INTERVAL_MS = 1000;

const CAPTAIN_TMUX_SOCKET = process.env.CAPTAIN_TMUX_SOCKET || "";
const WORKSPACE_TMUX_SOCKET = process.env.WORKSPACE_TMUX_SOCKET || "";

function tmuxExecAsync(args, socket) {
  const fullArgs = socket ? ["-S", socket, ...args] : args;
  return new Promise((resolve) => {
    execFile("tmux", fullArgs, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function safeInt(s, fallback) {
  const n = Number.parseInt(String(s || ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function collectPanesFromSocket(socket) {
  const sessionsRaw = await tmuxExecAsync(["list-sessions", "-F", "#{session_name}\t#{session_id}"], socket);
  if (!sessionsRaw.trim()) return [];

  const sessionLines = sessionsRaw.trim().split("\n");

  const sessions = (await Promise.all(sessionLines.map(async (sLine) => {
    const tabIdx = sLine.indexOf("\t");
    if (tabIdx < 0) return null;
    const sessionName = sLine.slice(0, tabIdx);
    const sessionId = sLine.slice(tabIdx + 1);
    if (!sessionName) return null;

    const windowsRaw = await tmuxExecAsync([
      "list-windows",
      "-t",
      sessionId || sessionName,
      "-F",
      "#{window_name}\t#{window_id}\t#{window_index}",
    ], socket);
    if (!windowsRaw.trim()) return null;

    const windowLines = windowsRaw.trim().split("\n");
    const windows = (await Promise.all(windowLines.map(async (wLine) => {
      const parts = wLine.split("\t");
      if (parts.length < 2) return null;
      const windowName = parts[0];
      const windowId = parts[1];
      const windowIndex = safeInt(parts[2], null);
      if (!windowName) return null;

      const panesRaw = await tmuxExecAsync([
        "list-panes",
        "-t",
        windowId || `${sessionName}:${windowName}`,
        "-F",
        "#{pane_index}\t#{pane_id}",
      ], socket);

      const paneLines = panesRaw.trim() ? panesRaw.trim().split("\n") : [];
      const panes = (await Promise.all(paneLines.map(async (pLine) => {
        const pParts = pLine.split("\t");
        if (pParts.length < 2) return null;
        const paneIndex = safeInt(pParts[0], null);
        const paneId = pParts[1];
        if (paneIndex === null || !paneId) return null;

        const raw = await tmuxExecAsync(["capture-pane", "-t", paneId, "-p", "-S", "-200"], socket);
        const content = raw;

        const winIdx = windowIndex === null ? 0 : windowIndex;
        const target = `${sessionName}:${winIdx}.${paneIndex}`;
        return { index: paneIndex, id: paneId, target, content };
      }))).filter(Boolean);

      panes.sort((a, b) => a.index - b.index);
      return { name: windowName, index: windowIndex, panes };
    }))).filter(Boolean);

    return { name: sessionName, windows };
  }))).filter(Boolean);

  return sessions;
}

async function collectPanes() {
  // If dual-socket mode is configured, query both servers and merge
  if (CAPTAIN_TMUX_SOCKET || WORKSPACE_TMUX_SOCKET) {
    const [captainSessions, workspaceSessions] = await Promise.all([
      CAPTAIN_TMUX_SOCKET ? collectPanesFromSocket(CAPTAIN_TMUX_SOCKET) : [],
      WORKSPACE_TMUX_SOCKET ? collectPanesFromSocket(WORKSPACE_TMUX_SOCKET) : [],
    ]);
    return { sessions: [...captainSessions, ...workspaceSessions] };
  }

  // Legacy single-server mode (TMUX_TMPDIR)
  const sessions = await collectPanesFromSocket(null);
  return { sessions };
}

// --- On-demand lifecycle ---

let timer = null;
let running = false;
let generation = 0;
let lastStateJson = "";
let lastState = null;

async function tick(broadcast, gen) {
  if (!running || gen !== generation) return;

  try {
    const state = await collectPanes();
    const stateJson = JSON.stringify(state);

    if (stateJson !== lastStateJson) {
      lastStateJson = stateJson;
      lastState = state;
      broadcast(state);
    }
  } catch (err) {
    console.error("[status-stream] error:", err.message);
  }

  if (running && gen === generation) {
    timer = setTimeout(() => tick(broadcast, gen), POLL_INTERVAL_MS);
  }
}

function start(broadcast) {
  if (running) return;
  running = true;
  generation++;
  lastStateJson = "";
  lastState = null;
  const gen = generation;
  console.log("[status-stream] started live streaming, interval=1s");
  tick(broadcast, gen);
}

function stop() {
  if (!running) return;
  running = false;
  generation++;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  lastStateJson = "";
  console.log("[status-stream] stopped live streaming");
}

function isRunning() {
  return running;
}

function getLastState() {
  return lastState;
}

module.exports = { start, stop, isRunning, getLastState, collectPanes };
