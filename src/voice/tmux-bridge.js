const { execSync, execFile, execFileSync } = require("child_process");

const TARGET = "captain:0";

function validatePaneTarget(target) {
  const t = String(target || "").trim();
  // Expected: session:window.pane (we use numeric window/pane indexes)
  if (!/^[-a-zA-Z0-9._]+:\d+\.\d+$/.test(t)) {
    throw new Error("Invalid tmux pane target: " + t);
  }
  return t;
}

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

  // Codex CLI renders an input prompt that starts with U+203A ("›") and shows status
  // lines like "? for shortcuts" and "XX% context left" near the bottom, without
  // Claude-style delimiter lines. If detected near the end, cut from the prompt onward.
  function cutAtCodexPromptFromEnd(maxScanLines) {
    const start = Math.max(0, lines.length - maxScanLines);
    let promptIdx = -1;
    for (let i = lines.length - 1; i >= start; i--) {
      const l = lines[i] || "";
      if (l.trimStart().startsWith("›")) {
        promptIdx = i;
        break;
      }
    }
    if (promptIdx < 0) return -1;

    let confirmed = false;
    const confirmStart = Math.max(start, promptIdx - 5);
    const confirmEnd = Math.min(lines.length, promptIdx + 15);
    for (let i = confirmStart; i < confirmEnd; i++) {
      const l = lines[i] || "";
      if (l.includes("? for shortcuts")) confirmed = true;
      if (/%\s*context\s+left/.test(l)) confirmed = true;
    }
    if (!confirmed) return -1;

    // Strip blank lines immediately above the prompt (Codex leaves vertical padding).
    let cutIdx = promptIdx;
    while (cutIdx > 0 && (lines[cutIdx - 1] || "").trim() === "") cutIdx--;
    return cutIdx;
  }

  const codexCutIdx = cutAtCodexPromptFromEnd(30);
  if (codexCutIdx >= 0) {
    return lines.slice(0, codexCutIdx).join("\n").trimEnd();
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
}

function sendCtrlCToPaneTarget(target) {
  const t = validatePaneTarget(target);
  execFileSync("tmux", ["send-keys", "-t", t, "C-c"], { timeout: 5000 });
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
};
