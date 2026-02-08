const { execSync, execFile } = require("child_process");

const TARGET = "captain:0";
// Claude Code's input box separator — strip this and everything below it
const INPUT_BOX_RE = /^[─]{20,}/m;

function stripInputBox(output) {
  const matches = [...output.matchAll(new RegExp(INPUT_BOX_RE.source, "gm"))];
  if (matches.length === 0) return output;
  const cutMatch = matches.length >= 2 ? matches[matches.length - 2] : matches[0];
  return output.slice(0, cutMatch.index).trimEnd();
}

function capturePaneOutput() {
  try {
    const raw = execSync(`tmux capture-pane -t ${TARGET} -p -S -500`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return stripInputBox(raw);
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
      resolve(err ? "" : stripInputBox(stdout));
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
  // Delay so Claude Code processes the pasted text before receiving Enter,
  // preventing bracketed-paste from swallowing the submission.
  await sleep(1000);
  execSync(`tmux send-keys -t ${TARGET} Enter`, { timeout: 5000 });
  await sleep(1000);
  execSync(`tmux send-keys -t ${TARGET} Enter`, { timeout: 5000 });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

module.exports = { sendToCaptain, capturePaneOutput, capturePaneOutputAsync };
