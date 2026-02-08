const { execSync, execFile } = require("child_process");

const TARGET = "captain:0";

function capturePaneOutput() {
  try {
    return execSync(`tmux capture-pane -t ${TARGET} -p -S -500`, {
      encoding: "utf-8",
      timeout: 5000,
    });
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
      resolve(err ? "" : stdout);
    });
  });
}

function sendToCaptain(text) {
  execSync(`tmux send-keys -t ${TARGET} -l ${shellEscape(text)}`, {
    timeout: 5000,
  });
  execSync(`tmux send-keys -t ${TARGET} Enter`, { timeout: 5000 });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

module.exports = { sendToCaptain, capturePaneOutput, capturePaneOutputAsync };
