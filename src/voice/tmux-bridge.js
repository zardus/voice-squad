const { execSync, execFile } = require("child_process");

const TARGET = "captain:0";
// Strip Claude/Codex interactive input chrome (textbox + autosuggest) from a captured pane.
// This keeps the UI's "Terminal" view focused on conversation/log output.
function stripInputBox(output) {
  const lines = output.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  const delimiterIdxs = [];

  function isDelimiterLine(line) {
    const s = (line || "").trim();
    if (s.length < 20) return false;
    let dashy = 0;
    for (const ch of s) {
      if (ch === "-" || ch === "─" || ch === "━") dashy++;
      else return false;
    }
    return dashy / s.length >= 0.9;
  }

  for (let i = 0; i < lines.length; i++) {
    if (isDelimiterLine(lines[i])) delimiterIdxs.push(i);
  }

  // Claude Code renders the input box area under two long delimiter lines.
  // Cut at the *second-to-last* delimiter when scanning backward from the end.
  function cutAtSecondToLastDelimiterFromEnd(maxScanLines) {
    let found = 0;
    for (let i = lines.length - 1; i >= 0 && (lines.length - 1 - i) < maxScanLines; i--) {
      if (isDelimiterLine(lines[i])) {
        found++;
        if (found === 2) return i;
      }
    }
    return -1;
  }

  const backwardCutIdx = cutAtSecondToLastDelimiterFromEnd(400);
  if (backwardCutIdx >= 0) {
    return lines.slice(0, backwardCutIdx).join("\n").trimEnd();
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

  // Fallback: cut before the last "❯" prompt line if present.
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] || "").trimStart().startsWith("❯")) {
      return lines.slice(0, i).join("\n").trimEnd();
    }
  }

  return output.trimEnd();
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
