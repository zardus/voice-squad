const { execSync, execFile, execFileSync } = require("child_process");

const TARGET = "captain:0";
const ENTER_RETRY_COUNT = 2;
const ENTER_RETRY_DELAY_MS = 400;
const TERMINAL_TRIM_BOTTOM_LINES = Number(process.env.TMUX_TERMINAL_TRIM_BOTTOM_LINES || 5);

function validatePaneTarget(target) {
  const t = String(target || "").trim();
  // Expected: session:window.pane (we use numeric window/pane indexes)
  if (!/^[-a-zA-Z0-9._]+:\d+\.\d+$/.test(t)) {
    throw new Error("Invalid tmux pane target: " + t);
  }
  return t;
}

// Terminal view: don't try to detect Claude/Codex UI chrome; just hide the bottom prompt area.
function trimBottomLines(output, n) {
  const drop = Math.max(0, Number(n) || 0);
  const lines = String(output || "").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (drop === 0) return lines.join("\n").trimEnd();
  // If the pane only contains the prompt area (or very little output), trimming would blank the UI.
  // In that case, keep the raw capture rather than showing nothing.
  if (lines.length <= drop) return lines.join("\n").trimEnd();
  return lines.slice(0, Math.max(0, lines.length - drop)).join("\n").trimEnd();
}

function capturePaneOutput() {
  try {
    const raw = execSync(`tmux capture-pane -t ${TARGET} -p -S -500`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return trimBottomLines(raw, TERMINAL_TRIM_BOTTOM_LINES);
  } catch {
    return "";
  }
}

function capturePaneOutputAsync() {
  return new Promise((resolve) => {
    execFile("tmux", ["capture-pane", "-t", TARGET, "-p", "-S", "-500"], {
      encoding: "utf-8",
      timeout: 5000,
    }, (err, stdout) => {
      resolve(err ? "" : trimBottomLines(stdout, TERMINAL_TRIM_BOTTOM_LINES));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToCaptain(text) {
  execSync(`tmux send-keys -t ${TARGET} -l ${shellEscape(text)}`, {
    timeout: 5000,
  });
  // Delay + repeated Enter reduces "typed but not submitted" failures caused by prompt UI/autocomplete.
  await sleep(ENTER_RETRY_DELAY_MS);
  for (let i = 0; i < ENTER_RETRY_COUNT; i++) {
    execSync(`tmux send-keys -t ${TARGET} Enter`, { timeout: 5000 });
    if (i < ENTER_RETRY_COUNT - 1) await sleep(ENTER_RETRY_DELAY_MS);
  }
}

function normalizeOneLineText(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").trim();
}

function sendTextToPaneTarget(target, text) {
  const t = validatePaneTarget(target);
  const line = normalizeOneLineText(text);
  if (!line) return;
  if (line.length > 4000) throw new Error("Text too long");

  execFileSync("tmux", ["send-keys", "-t", t, "-l", line], { timeout: 5000 });
  execFileSync("tmux", ["send-keys", "-t", t, "Enter"], { timeout: 5000 });
  execFileSync("tmux", ["send-keys", "-t", t, "Enter"], { timeout: 5000 });
}

function sendCtrlCToPaneTarget(target) {
  const t = validatePaneTarget(target);
  execFileSync("tmux", ["send-keys", "-t", t, "C-c"], { timeout: 5000 });
}

async function sendCtrlCSequenceToPaneTarget(target, options = {}) {
  const t = validatePaneTarget(target);
  const times = Math.max(1, Math.min(5, Number(options.times) || 3));
  const intervalMs = Math.max(0, Math.min(3000, Number(options.intervalMs) || 700));
  for (let i = 0; i < times; i++) {
    execFileSync("tmux", ["send-keys", "-t", t, "C-c"], { timeout: 5000 });
    if (i < times - 1 && intervalMs > 0) await sleep(intervalMs);
  }
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

module.exports = {
  sendToCaptain,
  capturePaneOutput,
  capturePaneOutputAsync,
  sendTextToPaneTarget,
  sendCtrlCToPaneTarget,
  sendCtrlCSequenceToPaneTarget,
};
