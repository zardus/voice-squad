const { execFileSync } = require("child_process");
const https = require("https");
const fs = require("fs");

const STATUS_FILE = "/tmp/squad-status.json";
const INTERVAL_MS = 30000;

const HAIKU_PROMPT =
  "You are summarizing the state of a multi-agent coding squad. Below are the terminal outputs from all active tmux sessions and windows. Give a concise status overview: what tasks are running, their progress, any errors or completions. Be specific about what each worker is doing. Format as a clean bullet list. Keep it under 300 words.";

function tmuxExec(args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 });
  } catch {
    return "";
  }
}

function collectPanes() {
  const sessionsRaw = tmuxExec(["list-sessions", "-F", "#{session_name}:#{session_id}"]);
  if (!sessionsRaw.trim()) return { dump: "", paneCount: 0, sessions: [] };

  const sessions = [];
  let dump = "";
  let paneCount = 0;

  for (const sLine of sessionsRaw.trim().split("\n")) {
    const [sessionName, sessionId] = sLine.split(":");
    if (!sessionName) continue;

    const windowsRaw = tmuxExec(["list-windows", "-t", sessionId || sessionName, "-F", "#{window_name}:#{window_id}"]);
    if (!windowsRaw.trim()) continue;

    const windows = [];
    for (const wLine of windowsRaw.trim().split("\n")) {
      const [windowName, windowId] = wLine.split(":");
      if (!windowName) continue;

      const content = tmuxExec(["capture-pane", "-t", windowId || `${sessionName}:${windowName}`, "-p", "-S", "-200"]);
      const snippet = content.trim().slice(-2000); // keep last 2000 chars for raw view
      paneCount++;

      dump += `=== Session: ${sessionName} | Window: ${windowName} ===\n${content}\n\n`;
      windows.push({ name: windowName, snippet });
    }

    sessions.push({ name: sessionName, windows });
  }

  return { dump, paneCount, sessions };
}

function callHaiku(dump) {
  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: `${HAIKU_PROMPT}\n\n${dump}` }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`Haiku API ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            const data = JSON.parse(text);
            resolve(data.content[0].text);
          } catch (e) {
            reject(new Error("Failed to parse Haiku response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

// --- On-demand lifecycle ---

let timer = null;
let running = false;
let generation = 0; // monotonic counter to detect stale callbacks after stop/start

async function tick(broadcast, gen) {
  try {
    const { dump, paneCount, sessions } = collectPanes();
    if (!dump.trim()) {
      console.log("[status] no tmux sessions found, skipping");
      return;
    }

    console.log(`[status] captured ${paneCount} panes across ${sessions.length} sessions, ${dump.length} chars`);
    const summary = await callHaiku(dump);

    // If stop() was called (or stop+start) while the LLM call was in flight, discard
    if (!running || gen !== generation) return;

    console.log(`[status] summary: ${summary.slice(0, 100)}...`);

    const result = {
      timestamp: new Date().toISOString(),
      summary,
      paneCount,
      sessions,
    };

    fs.writeFileSync(STATUS_FILE, JSON.stringify(result, null, 2));
    broadcast(result);
  } catch (err) {
    console.error("[status] error:", err.message);
  }
}

function runCycle(broadcast, gen) {
  tick(broadcast, gen).then(() => {
    if (running && gen === generation) {
      timer = setTimeout(() => {
        if (running && gen === generation) {
          runCycle(broadcast, gen);
        }
      }, INTERVAL_MS);
    }
  });
}

function start(broadcast) {
  if (running) return;
  running = true;
  generation++;
  const gen = generation;
  console.log("[status] started on-demand refresh, interval=30s");
  runCycle(broadcast, gen);
}

function stop() {
  if (!running) return;
  running = false;
  generation++;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("[status] stopped on-demand refresh");
}

function isRunning() {
  return running;
}

module.exports = { start, stop, isRunning };
