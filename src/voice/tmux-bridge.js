const { execSync } = require("child_process");

const SESSION = "captain";
const POLL_INTERVAL = 500;
const STABLE_THRESHOLD = 3000; // 3s of no change = done
const HARD_TIMEOUT = 120000; // 120s max wait
const PROMPT_RE = /[❯>$#]\s*$/;

function capturePaneOutput() {
  try {
    return execSync(`tmux capture-pane -t ${SESSION} -p -S -500`, {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return "";
  }
}

function sendToCaptain(text) {
  // Use -l for literal text (no metacharacter interpretation)
  execSync(`tmux send-keys -t ${SESSION} -l ${shellEscape(text)}`, {
    timeout: 5000,
  });
  // Send Enter separately
  execSync(`tmux send-keys -t ${SESSION} Enter`, { timeout: 5000 });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Poll captain output until done.
 * Calls onOutput(text, incremental) as new content arrives.
 * Returns the full output when done.
 */
function pollCaptainOutput(onOutput, onDone, onError) {
  const baselineOutput = capturePaneOutput();
  let lastOutput = baselineOutput;
  let lastChangeTime = Date.now();
  const startTime = Date.now();

  const timer = setInterval(() => {
    try {
      const current = capturePaneOutput();

      if (current !== lastOutput) {
        // New content since baseline
        const newContent = extractNewContent(baselineOutput, current);
        if (newContent) {
          onOutput(newContent, true);
        }
        lastOutput = current;
        lastChangeTime = Date.now();
      }

      const elapsed = Date.now() - startTime;
      const stableFor = Date.now() - lastChangeTime;

      // Done conditions: stable for 3s and prompt visible, or hard timeout
      if (
        (stableFor >= STABLE_THRESHOLD && PROMPT_RE.test(current.trimEnd())) ||
        elapsed >= HARD_TIMEOUT
      ) {
        clearInterval(timer);
        const fullOutput = extractNewContent(baselineOutput, current);
        onDone(fullOutput || "");
      }
    } catch (err) {
      clearInterval(timer);
      onError(err);
    }
  }, POLL_INTERVAL);

  // Return cancel function
  return () => clearInterval(timer);
}

function extractNewContent(baseline, current) {
  // Find where current diverges from baseline
  const baseLines = baseline.trimEnd().split("\n");
  const currLines = current.trimEnd().split("\n");

  // Find the last matching line from baseline
  let matchEnd = 0;
  for (let i = 0; i < baseLines.length && i < currLines.length; i++) {
    if (baseLines[i] === currLines[i]) {
      matchEnd = i + 1;
    } else {
      break;
    }
  }

  const newLines = currLines.slice(matchEnd);
  return newLines.join("\n").trim();
}

module.exports = { sendToCaptain, pollCaptainOutput, capturePaneOutput };
