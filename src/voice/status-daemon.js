const { execFile } = require("child_process");

const POLL_INTERVAL_MS = 1000;

function tmuxExecAsync(args) {
  return new Promise((resolve) => {
    execFile("tmux", args, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function stripInputBox(output) {
  const lines = output.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  function isDelimiterLine(line) {
    const s = (line || "").trim();
    if (s.length < 20) return false;
    for (const ch of s) {
      if (ch !== "-" && ch !== "─" && ch !== "━") return false;
    }
    return true;
  }

  let found = 0;
  for (let i = lines.length - 1; i >= 0 && (lines.length - 1 - i) < 400; i--) {
    if (isDelimiterLine(lines[i])) {
      found++;
      if (found === 2) return lines.slice(0, i).join("\n").trimEnd();
    }
  }

  const delimiterIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (isDelimiterLine(lines[i])) delimiterIdxs.push(i);
  }

  function looksLikeInputChrome(after) {
    for (let i = 0; i < Math.min(60, after.length); i++) {
      const l = after[i] || "";
      if (l.trimStart().startsWith("❯")) return true;
      if (l.includes("┌") || l.includes("└") || l.includes("│")) return true;
      if (l.includes("Ctrl") && l.includes("Enter")) return true;
    }
    return false;
  }

  const uiDelimiterIdxs = delimiterIdxs.filter((idx) => looksLikeInputChrome(lines.slice(idx + 1)));
  if (uiDelimiterIdxs.length) {
    const cutIdx = uiDelimiterIdxs.length >= 2 ? uiDelimiterIdxs[uiDelimiterIdxs.length - 2] : uiDelimiterIdxs[0];
    return lines.slice(0, cutIdx).join("\n").trimEnd();
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] || "").trimStart().startsWith("❯")) {
      return lines.slice(0, i).join("\n").trimEnd();
    }
  }

  return output.trimEnd();
}

async function collectPanes() {
  const sessionsRaw = await tmuxExecAsync(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
  if (!sessionsRaw.trim()) return { sessions: [] };

  const sessionLines = sessionsRaw.trim().split("\n");

  const sessions = (await Promise.all(sessionLines.map(async (sLine) => {
    const tabIdx = sLine.indexOf("\t");
    if (tabIdx < 0) return null;
    const sessionName = sLine.slice(0, tabIdx);
    const sessionId = sLine.slice(tabIdx + 1);
    if (!sessionName) return null;

    const windowsRaw = await tmuxExecAsync(["list-windows", "-t", sessionId || sessionName, "-F", "#{window_name}\t#{window_id}"]);
    if (!windowsRaw.trim()) return null;

    const windowLines = windowsRaw.trim().split("\n");
    const windows = (await Promise.all(windowLines.map(async (wLine) => {
      const wTabIdx = wLine.indexOf("\t");
      if (wTabIdx < 0) return null;
      const windowName = wLine.slice(0, wTabIdx);
      const windowId = wLine.slice(wTabIdx + 1);
      if (!windowName) return null;

      const raw = await tmuxExecAsync(["capture-pane", "-t", windowId || `${sessionName}:${windowName}`, "-p", "-S", "-200"]);
      const content = stripInputBox(raw);
      return { name: windowName, content: content.trim().slice(-3000) };
    }))).filter(Boolean);

    return { name: sessionName, windows };
  }))).filter(Boolean);

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

module.exports = { start, stop, isRunning, getLastState };
