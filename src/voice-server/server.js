const express = require("express");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { execSync } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");
const {
  sendToCaptain,
  capturePaneOutputAsync,
  sendTextToPaneTarget,
  sendCtrlCToPaneTarget,
  sendCtrlCSequenceToPaneTarget,
} = require("./tmux-bridge");
const { transcribe } = require("./stt");
const { synthesize } = require("./tts");
const statusDaemon = require("./status-daemon");

const PORT = process.env.VOICE_PORT || 3000;
const TOKEN = process.env.VOICE_TOKEN;
const CAPTAIN_DIR = process.env.SQUAD_CAPTAIN_DIR || path.join(os.homedir(), "captain");
const CAPTAIN_CONFIG_FILE = path.join(CAPTAIN_DIR, "config.yml");

// Read captain type from config.yml (written by captain entrypoint), fall back to env var
function readCaptainConfig() {
  try {
    const content = fsSync.readFileSync(CAPTAIN_CONFIG_FILE, "utf8");
    const match = content.match(/^type:\s*(\S+)/m);
    if (match && (match[1] === "claude" || match[1] === "codex")) return match[1];
  } catch {}
  return null;
}

let CAPTAIN = readCaptainConfig() || process.env.SQUAD_CAPTAIN || "claude";
const TASK_DEFS_DIR = process.env.SQUAD_TASK_DEFS_DIR || path.join(CAPTAIN_DIR, "tasks");
const TASK_DEFS_PENDING_DIR = path.join(TASK_DEFS_DIR, "pending");
const TASK_DEFS_ARCHIVED_DIR = path.join(TASK_DEFS_DIR, "archived");
const COMPLETED_TASKS_LIMIT = Number(process.env.SQUAD_COMPLETED_TASKS_LIMIT || process.env.COMPLETED_TASKS_LIMIT || 2000);
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64 * 1024 * 1024);
const MAX_AUDIO_UPLOAD_BYTES = Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 64 * 1024 * 1024);
const VOICE_HISTORY_FILE = process.env.VOICE_HISTORY_FILE || "/tmp/voice-summary-history.json";
const VOICE_HISTORY_LIMIT = Number(process.env.VOICE_HISTORY_LIMIT || 1000);
const SPEAK_SOCKET_PATH = process.env.SPEAK_SOCKET_PATH || "/run/squad-sockets/speak.sock";

const REQUIRED_ENV = { VOICE_TOKEN: TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
const missing = Object.entries(REQUIRED_ENV).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[voice] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[voice] env OK: VOICE_TOKEN, OPENAI_API_KEY all set");

let voiceSummaryHistory = [];

function normalizeVoiceHistoryEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const timestamp = typeof item.timestamp === "string" && item.timestamp
        ? item.timestamp
        : new Date().toISOString();
      return { text, timestamp };
    })
    .filter((item) => item.text)
    .slice(0, VOICE_HISTORY_LIMIT);
}

async function loadVoiceSummaryHistory() {
  try {
    if (!fsSync.existsSync(VOICE_HISTORY_FILE)) {
      voiceSummaryHistory = [];
      return;
    }
    const raw = await fs.readFile(VOICE_HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    voiceSummaryHistory = normalizeVoiceHistoryEntries(parsed.entries);
    console.log(`[voice-history] loaded ${voiceSummaryHistory.length} entries`);
  } catch (err) {
    console.warn(`[voice-history] failed to load history: ${err.message}`);
    voiceSummaryHistory = [];
  }
}

async function persistVoiceSummaryHistory() {
  try {
    await fs.mkdir(path.dirname(VOICE_HISTORY_FILE), { recursive: true });
    await fs.writeFile(
      VOICE_HISTORY_FILE,
      JSON.stringify({ entries: voiceSummaryHistory }, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(`[voice-history] failed to persist history: ${err.message}`);
  }
}

async function addVoiceSummaryEntry(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const entry = { text: trimmed, timestamp: new Date().toISOString() };
  voiceSummaryHistory.unshift(entry);
  if (voiceSummaryHistory.length > VOICE_HISTORY_LIMIT) {
    voiceSummaryHistory.length = VOICE_HISTORY_LIMIT;
  }
  await persistVoiceSummaryHistory();
  return entry;
}

function checkToken(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get("token") === TOKEN;
}

function normalizeTtsFormat(fmt) {
  const f = String(fmt || "").toLowerCase();
  if (f === "mp3" || f === "aac" || f === "opus") return f;
  return "mp3";
}

function ttsMimeFromFormat(fmt) {
  switch (fmt) {
    case "mp3":
      return "audio/mpeg";
    case "aac":
      return "audio/aac";
    case "opus":
    default:
      // Opus frames inside an Ogg container.
      return 'audio/ogg; codecs="opus"';
  }
}

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Build metadata (read once at startup)
const BUILD_TIME = (() => {
  try { return fsSync.readFileSync(path.join(__dirname, "build-time.txt"), "utf8").trim(); } catch { return "unknown"; }
})();
const GIT_COMMIT = (() => {
  try { return fsSync.readFileSync(path.join(__dirname, "git-commit.txt"), "utf8").trim(); } catch { return "unknown"; }
})();

app.get("/api/version", (req, res) => {
  res.json({ build_time: BUILD_TIME, git_commit: GIT_COMMIT });
});

app.get("/api/status", (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const state = statusDaemon.getLastState();
  res.json(state || { sessions: [] });
});

app.get("/api/voice-history", (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ entries: voiceSummaryHistory });
});

function sanitizeTaskName(taskName) {
  return String(taskName || "task")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

function completedAtToEpoch(item) {
  const t = Date.parse(item.completed_at || "");
  return Number.isFinite(t) ? t : 0;
}

function createdAtToEpoch(item) {
  const t = Date.parse(item.created_at || "");
  return Number.isFinite(t) ? t : 0;
}

async function listPendingTasks() {
  let entries = [];
  try {
    await fs.mkdir(TASK_DEFS_PENDING_DIR, { recursive: true });
    entries = await fs.readdir(TASK_DEFS_PENDING_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[pending-tasks] cannot read pending tasks dir ${TASK_DEFS_PENDING_DIR}: ${err.message}`);
    return [];
  }

  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".task")) continue;
    const fullPath = path.join(TASK_DEFS_PENDING_DIR, entry.name);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(fullPath, "utf8"),
        fs.stat(fullPath),
      ]);
      tasks.push({
        task_name: path.basename(entry.name, ".task"),
        content: raw,
        created_at: new Date(stat.mtimeMs || Date.now()).toISOString(),
      });
    } catch (err) {
      console.warn(`[pending-tasks] skipping ${entry.name}: ${err.message}`);
    }
  }

  tasks.sort((a, b) => createdAtToEpoch(b) - createdAtToEpoch(a));
  return tasks;
}

async function listCompletedTasks() {
  let entries = [];
  try {
    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });
    entries = await fs.readdir(TASK_DEFS_ARCHIVED_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[completed-tasks] cannot read archived tasks dir ${TASK_DEFS_ARCHIVED_DIR}: ${err.message}`);
    return [];
  }

  const KNOWN_EXTS = [".task", ".summary", ".log", ".title", ".results"];

  // Group files by task name (strip known extensions)
  const taskFiles = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = KNOWN_EXTS.find((e) => entry.name.endsWith(e));
    if (!ext) continue;
    const taskName = entry.name.slice(0, -ext.length);
    if (!taskName) continue;
    if (!taskFiles.has(taskName)) taskFiles.set(taskName, {});
    const key = ext.slice(1); // remove leading dot
    taskFiles.get(taskName)[key] = entry.name;
  }

  const tasks = [];
  for (const [taskName, files] of taskFiles) {
    let summary = null;
    if (files.summary) {
      try {
        summary = (await fs.readFile(path.join(TASK_DEFS_ARCHIVED_DIR, files.summary), "utf8")).trim();
      } catch {}
    }

    let title = null;
    if (files.title) {
      try {
        title = (await fs.readFile(path.join(TASK_DEFS_ARCHIVED_DIR, files.title), "utf8")).trim();
      } catch {}
    }

    let results = null;
    if (files.results) {
      try {
        results = (await fs.readFile(path.join(TASK_DEFS_ARCHIVED_DIR, files.results), "utf8")).trim();
      } catch {}
    }

    let taskDefinition = null;
    if (files.task) {
      try {
        taskDefinition = (await fs.readFile(path.join(TASK_DEFS_ARCHIVED_DIR, files.task), "utf8")).trim();
      } catch {}
    }

    const hasLog = !!files.log;

    // Use mtime of the most relevant file for completed_at
    let completedAt = null;
    const statFile = files.summary || files.task || files.log;
    if (statFile) {
      try {
        const st = await fs.stat(path.join(TASK_DEFS_ARCHIVED_DIR, statFile));
        completedAt = new Date(st.mtimeMs).toISOString();
      } catch {}
    }

    tasks.push({
      task_name: taskName,
      title: title || null,
      summary: summary || null,
      results: results || null,
      task_definition: taskDefinition || null,
      has_log: hasLog,
      completed_at: completedAt || new Date().toISOString(),
    });
  }

  tasks.sort((a, b) => completedAtToEpoch(b) - completedAtToEpoch(a));

  if (Number.isFinite(COMPLETED_TASKS_LIMIT) && COMPLETED_TASKS_LIMIT > 0) {
    return tasks.slice(0, COMPLETED_TASKS_LIMIT);
  }
  return tasks;
}

app.get("/api/pending-tasks", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const tasks = await listPendingTasks();

    // Ensure stable API shape: always include worker_status field
    for (const task of tasks) {
      task.worker_status = null;
    }

    // Enrich each task with a Haiku-generated worker status summary (opt-in via query param)
    const enrichStatus = url.searchParams.get("worker_status") === "1";
    if (enrichStatus) {
      try {
        const { sessions } = await statusDaemon.collectPanes();

        // Build map: lowercase window name -> combined pane content
        const windowContentMap = new Map();
        for (const session of sessions) {
          for (const win of session.windows) {
            let content = "";
            if (Array.isArray(win.panes) && win.panes.length) {
              content = win.panes.map((p) => p.content || "").join("\n");
            } else if (typeof win.content === "string") {
              content = win.content;
            }
            if (content.trim()) {
              windowContentMap.set(win.name.toLowerCase(), content);
            }
          }
        }

        const enrichmentTasks = tasks
          .filter((task) => {
            const taskName = (task.task_name || "").toLowerCase();
            return windowContentMap.has(taskName);
          })
          .map((task) => () => {
            const taskName = (task.task_name || "").toLowerCase();
            const paneContent = windowContentMap.get(taskName);
            const lines = paneContent.split("\n");
            const recentLines = scrubSecrets(lines.slice(-50).join("\n"));
            const dump = `## Task Definition\n${task.content || "(no content)"}\n\n## Recent Terminal Output\n${recentLines}`;

            // Per-request timeout to avoid stalling the entire response
            return Promise.race([
              callHaiku(dump, WORKER_STATUS_PROMPT).then((result) => {
                task.worker_status = result;
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), WORKER_STATUS_TIMEOUT_MS)
              ),
            ]).catch((err) => {
              console.warn(`[pending-tasks] haiku status failed for ${task.task_name}: ${err.message}`);
              task.worker_status = null;
            });
          });

        await limitedConcurrency(enrichmentTasks, WORKER_STATUS_CONCURRENCY);
      } catch (err) {
        console.warn(`[pending-tasks] worker status enrichment failed: ${err.message}`);
      }
    }

    res.json({ tasks });
  } catch (err) {
    console.error("[pending-tasks] GET error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/completed-tasks", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const tasks = await listCompletedTasks();
    res.json({ tasks });
  } catch (err) {
    console.error("[completed-tasks] GET error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/completed-tasks", async (req, res) => {
  const { token, ...summary } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!summary || typeof summary !== "object") {
    return res.status(400).json({ error: "Missing summary object" });
  }
  if (!summary.task_name || typeof summary.task_name !== "string" || !summary.task_name.trim()) {
    return res.status(400).json({ error: "Missing or empty 'task_name'" });
  }

  const taskName = sanitizeTaskName(summary.task_name);

  try {
    await fs.mkdir(TASK_DEFS_ARCHIVED_DIR, { recursive: true });

    const summaryText = summary.short_summary || summary.summary || "";
    if (summaryText) {
      await fs.writeFile(
        path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.summary`),
        summaryText + "\n",
        "utf8"
      );
    }

    if (summary.title) {
      await fs.writeFile(
        path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.title`),
        summary.title + "\n",
        "utf8"
      );
    }

    if (summary.results || summary.detailed_summary) {
      await fs.writeFile(
        path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.results`),
        (summary.results || summary.detailed_summary) + "\n",
        "utf8"
      );
    }

    if (summary.task_definition) {
      await fs.writeFile(
        path.join(TASK_DEFS_ARCHIVED_DIR, `${taskName}.task`),
        summary.task_definition + "\n",
        "utf8"
      );
    }

    res.status(201).json({ ok: true, task_name: taskName });
  } catch (err) {
    console.error("[completed-tasks] POST error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/task-log", async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const taskName = url.searchParams.get("task");
  if (!taskName) {
    return res.status(400).json({ error: "Missing 'task' parameter" });
  }
  if (taskName.includes("/") || taskName.includes("\\") || taskName === ".." || taskName === ".") {
    return res.status(400).json({ error: "Invalid task name" });
  }
  try {
    const logPath = path.join(TASK_DEFS_ARCHIVED_DIR, taskName + ".log");
    const content = await fs.readFile(logPath, "utf8");
    res.json({ log: content });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "Log not found" });
    }
    res.status(500).json({ error: err.message });
  }
});

async function handleSpeakRequest(body, res) {
  const { text, playbackOnly, format } = body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Missing or empty 'text' field" });
  }
  try {
    const trimmed = text.trim();
    const requestTtsFormat = normalizeTtsFormat(format);
    const requestTtsMime = ttsMimeFromFormat(requestTtsFormat);
    console.log(`[speak] "${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}"`);
    if (playbackOnly === true) {
      const { audio } = await synthesize(trimmed, requestTtsFormat);
      console.log(`[speak] synthesized ${audio.length} bytes (format=${requestTtsFormat}, playbackOnly=true)`);
      res.setHeader("Content-Type", requestTtsMime);
      res.setHeader("Cache-Control", "no-store");
      res.send(audio);
      return;
    }
    const entry = await addVoiceSummaryEntry(trimmed);
    let sent = 0;
    const speakMsg = JSON.stringify({
      type: "speak_text",
      text: trimmed,
      timestamp: entry ? entry.timestamp : new Date().toISOString(),
    });

    // Send speak_text first (per-client ordering is preserved; audio follows per-format).
    const openClients = [];
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.send(speakMsg);
      openClients.push(client);
    }

    const clientsByFormat = new Map(); // format -> [ws,...]
    for (const client of openClients) {
      const desired = normalizeTtsFormat(client.ttsFormat || requestTtsFormat);
      const list = clientsByFormat.get(desired) || [];
      list.push(client);
      clientsByFormat.set(desired, list);
    }

    const formatsUsed = [];
    for (const [ttsFormat, clients] of clientsByFormat.entries()) {
      formatsUsed.push(ttsFormat);
      const { audio } = await synthesize(trimmed, ttsFormat);
      console.log(`[speak] synthesized ${audio.length} bytes (format=${ttsFormat}) for ${clients.length} client(s)`);
      for (const client of clients) {
        if (client.readyState !== 1) continue;
        // Be explicit: this must be a binary WebSocket frame for browsers to treat it as audio bytes.
        client.send(audio, { binary: true });
        sent++;
      }
    }

    console.log(`[speak] sent to ${sent}/${wss.clients.size} client(s)`);
    res.json({ ok: true, clients: sent, formats: formatsUsed.sort() });
  } catch (err) {
    console.error("[speak] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

app.post("/api/speak", async (req, res) => {
  const { token, ...payload } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return handleSpeakRequest(payload, res);
});

app.post("/api/interrupt", (req, res) => {
  const { token } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const captainSocket = process.env.CAPTAIN_TMUX_SOCKET || "";
    const socketArgs = captainSocket ? `-S ${captainSocket} ` : "";
    // Some captain runs need multiple SIGINT attempts before returning to prompt.
    for (let i = 0; i < 3; i++) {
      execSync(`tmux ${socketArgs}send-keys -t captain:0 C-c`, { timeout: 5000 });
    }
    console.log("[interrupt] sent Ctrl+C x3 to captain pane captain:0");
    res.json({ ok: true });
  } catch (err) {
    console.error("[interrupt] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

let restartInProgress = false;
let loginState = { inProgress: false, tool: null, url: null, status: "idle", error: null, child: null };

app.post("/api/restart-captain", async (req, res) => {
  const { token, tool } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (tool !== "claude" && tool !== "codex") {
    return res.status(400).json({ error: "tool must be 'claude' or 'codex'" });
  }
  if (restartInProgress) {
    return res.status(409).json({ error: "A restart is already in progress" });
  }

  restartInProgress = true;

  try {
    // Write the desired captain type to config.yml — the captain entrypoint reads this on boot
    await fs.mkdir(CAPTAIN_DIR, { recursive: true });
    await fs.writeFile(CAPTAIN_CONFIG_FILE, `type: ${tool}\n`);
    console.log(`[restart] wrote ${CAPTAIN_CONFIG_FILE}: type=${tool}`);

    // Kill the sleep infinity process in the captain container via its tmux socket.
    // The captain entrypoint runs `sleep infinity` (without exec) so bash is PID 1.
    // Killing sleep causes bash to exit -> container dies -> docker-compose restarts it.
    const captainSocket = process.env.CAPTAIN_TMUX_SOCKET || "";
    const socketArgs = captainSocket ? `-S ${captainSocket}` : "";
    // pkill -P 1 targets children of PID 1 (the entrypoint bash) — avoids self-match
    const killCmd = `tmux ${socketArgs} new-window 'sudo pkill -P 1 sleep'`;
    console.log(`[restart] sending: ${killCmd}`);
    execSync(killCmd, { timeout: 10000 });

    CAPTAIN = tool;
    console.log(`[restart] captain container kill triggered, will restart as ${tool}`);
    res.json({ ok: true, tool });
  } catch (err) {
    console.error(`[restart] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    // Clear the flag after a delay — the captain container needs time to die and restart.
    // The voice server itself stays up; restartInProgress just prevents double-clicks.
    setTimeout(() => { restartInProgress = false; }, 15000);
  }
});

app.get("/api/restart-status", (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ restartInProgress, captain: CAPTAIN });
});

app.post("/api/login", (req, res) => {
  const { token: reqToken, tool } = req.body || {};
  if (reqToken !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (tool !== "claude" && tool !== "codex") {
    return res.status(400).json({ error: "tool must be 'claude' or 'codex'" });
  }
  if (loginState.inProgress) {
    return res.status(409).json({ error: "A login is already in progress" });
  }

  const { spawn } = require("child_process");

  const cmd = tool === "claude" ? "claude" : "codex";
  const args = tool === "claude" ? ["login"] : ["auth", "login"];

  loginState = { inProgress: true, tool, url: null, status: "spawning", error: null, child: null };

  console.log(`[login] spawning ${cmd} ${args.join(" ")}...`);

  const child = spawn(cmd, args, {
    env: { ...process.env, BROWSER: "" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 0,
  });
  loginState.child = child;

  const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    if (loginState.child === child && loginState.inProgress) {
      console.log("[login] timed out after 5 minutes");
      loginState.status = "error";
      loginState.error = "Login timed out after 5 minutes";
      loginState.inProgress = false;
      try { child.kill("SIGTERM"); } catch {}
      loginState.child = null;
    }
  }, LOGIN_TIMEOUT_MS);

  const urlRegex = /https?:\/\/[^\s"'<>]+/;

  function handleOutput(data) {
    const text = data.toString();
    console.log(`[login] output: ${text.trim()}`);
    if (!loginState.url) {
      const match = text.match(urlRegex);
      if (match) {
        loginState.url = match[0];
        loginState.status = "waiting_for_auth";
        console.log(`[login] OAuth URL found: ${loginState.url}`);
      }
    }
  }

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);

  child.on("error", (err) => {
    clearTimeout(timeoutTimer);
    console.error(`[login] spawn error: ${err.message}`);
    loginState.status = "error";
    loginState.error = err.message;
    loginState.inProgress = false;
    loginState.child = null;
  });

  child.on("close", (code) => {
    clearTimeout(timeoutTimer);
    if (loginState.child !== child) return;
    if (code === 0) {
      console.log(`[login] ${tool} login completed successfully`);
      loginState.status = "success";
    } else if (loginState.status !== "error") {
      console.log(`[login] ${tool} login exited with code ${code}`);
      loginState.status = "error";
      loginState.error = `Login process exited with code ${code}`;
    }
    loginState.inProgress = false;
    loginState.child = null;
  });

  // Write a newline to stdin in case the CLI is waiting for confirmation
  try { child.stdin.write("\n"); } catch {}

  res.json({ ok: true });
});

app.get("/api/login-status", (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({
    status: loginState.status,
    url: loginState.url,
    tool: loginState.tool,
    error: loginState.error,
    inProgress: loginState.inProgress,
  });
});

const HAIKU_PROMPT =
  "You are summarizing the state of a multi-agent coding squad. Below are the terminal outputs from all active tmux sessions and windows. Give a concise status overview: what tasks are running, their progress, any errors or completions. Be specific about what each worker is doing. Format as a clean bullet list. Keep it under 300 words.";

const WORKER_STATUS_PROMPT =
  "You are summarizing a single worker agent's progress. Below is the task definition it was assigned, followed by its recent terminal output. Give a concise status covering: (1) what the worker is currently doing, (2) any issues or errors encountered, (3) what it has completed so far. Use bullet points. Keep it under 100 words.";

// Scrub common secret patterns from terminal output before sending to external APIs
const SECRET_PATTERNS = [
  /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|VOICE_TOKEN|API_KEY|SECRET_KEY|DATABASE_URL|REDIS_URL)=[^\s'";]+/gi,
  /(?:sk-[a-zA-Z0-9_-]{20,})/g,           // OpenAI-style keys
  /(?:AKIA[0-9A-Z]{16})/g,                 // AWS access key IDs
  /(?:ghp_[a-zA-Z0-9]{36,})/g,            // GitHub personal access tokens
  /(?:gho_[a-zA-Z0-9]{36,})/g,            // GitHub OAuth tokens
  /(?:ghs_[a-zA-Z0-9]{36,})/g,            // GitHub server tokens
  /(?:github_pat_[a-zA-Z0-9_]{22,})/g,    // GitHub fine-grained PATs
  /(?:xox[bpsr]-[a-zA-Z0-9-]+)/g,         // Slack tokens
  /(?:Bearer\s+[a-zA-Z0-9._~+\/=-]{20,})/gi, // Bearer tokens
  /(?:-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----)/g,
];

function scrubSecrets(text) {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

// Concurrency-limited Promise.all helper
const WORKER_STATUS_CONCURRENCY = 3;
const WORKER_STATUS_TIMEOUT_MS = 10000;

async function limitedConcurrency(tasks, concurrency) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then((r) => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

function callHaiku(dump, prompt) {
  const systemPrompt = prompt || HAIKU_PROMPT;
  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: `${systemPrompt}\n\n${dump}` }],
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

app.post("/api/summary", async (req, res) => {
  const { token } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { sessions } = await statusDaemon.collectPanes();
    if (!sessions.length) {
      return res.json({ summary: "No tmux sessions found." });
    }
    let dump = "";
    for (const session of sessions) {
      for (const win of session.windows) {
        dump += `=== Session: ${session.name} | Window: ${win.name} ===\n`;
        if (Array.isArray(win.panes) && win.panes.length) {
          for (const pane of win.panes) {
            dump += `--- Pane: ${pane.target || pane.id || pane.index} ---\n${pane.content || ""}\n\n`;
          }
        } else if (typeof win.content === "string") {
          dump += `${win.content}\n\n`;
        } else {
          dump += "(no content)\n\n";
        }
      }
    }
    console.log(`[summary] captured ${sessions.length} sessions, ${dump.length} chars, calling Haiku...`);
    const summary = await callHaiku(dump);
    console.log(`[summary] done: ${summary.slice(0, 100)}...`);
    res.json({ summary });
  } catch (err) {
    console.error("[summary] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const internalSpeakApp = express();
internalSpeakApp.use(express.json());
internalSpeakApp.post("/speak", async (req, res) => handleSpeakRequest(req.body || {}, res));
internalSpeakApp.use((req, res) => res.status(404).json({ error: "Not found" }));
const internalSpeakServer = http.createServer(internalSpeakApp);
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

async function startInternalSpeakSocket() {
  await fs.mkdir(path.dirname(SPEAK_SOCKET_PATH), { recursive: true });
  try {
    await fs.unlink(SPEAK_SOCKET_PATH);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  await new Promise((resolve, reject) => {
    internalSpeakServer.once("error", reject);
    internalSpeakServer.listen(SPEAK_SOCKET_PATH, () => {
      internalSpeakServer.removeListener("error", reject);
      resolve();
    });
  });

  try {
    fsSync.chmodSync(SPEAK_SOCKET_PATH, 0o660);
  } catch (err) {
    console.warn(`[voice] failed to chmod speak socket: ${err.message}`);
  }
  console.log(`[voice] internal speak socket listening on ${SPEAK_SOCKET_PATH}`);
}

function cleanupSpeakSocket() {
  try {
    if (fsSync.existsSync(SPEAK_SOCKET_PATH)) {
      fsSync.unlinkSync(SPEAK_SOCKET_PATH);
    }
  } catch {}
}

process.on("exit", cleanupSpeakSocket);
process.on("SIGINT", () => {
  cleanupSpeakSocket();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupSpeakSocket();
  process.exit(0);
});

// Track clients with the status tab active
const statusClients = new Set();

function broadcastStatus(data) {
  const msg = JSON.stringify({ type: "status_stream_update", ...data });
  for (const client of statusClients) {
    if (client.readyState === 1 && client.bufferedAmount < 512 * 1024) {
      client.send(msg);
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  if (!checkToken(req)) {
    console.log("[ws] rejected upgrade — bad token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  console.log("[ws] client connected");

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ttsFormat = normalizeTtsFormat(url.searchParams.get("tts"));
    ws.ttsFormat = ttsFormat;
    ws.ttsMime = ttsMimeFromFormat(ttsFormat);
  } catch {
    ws.ttsFormat = "mp3";
    ws.ttsMime = ttsMimeFromFormat("mp3");
  }

  let audioChunks = [];
  let audioMimeType = "audio/webm";
  let audioBytes = 0;
  let audioTooLarge = false;

  ws.send(JSON.stringify({ type: "connected", captain: CAPTAIN }));
  ws.send(JSON.stringify({ type: "tts_config", format: ws.ttsFormat, mime: ws.ttsMime }));
  ws.send(JSON.stringify({ type: "voice_history", entries: voiceSummaryHistory }));

  let lastSnapshot = null;
  let snapshotInFlight = false;

  async function snapshotTick() {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (snapshotInFlight) return;
    // If the client is slow, avoid queueing more snapshots (they are full-text).
    if (ws.bufferedAmount > 256 * 1024) return;

    snapshotInFlight = true;
    try {
      const content = await capturePaneOutputAsync();
      if (content !== lastSnapshot) {
        lastSnapshot = content;
        ws.send(JSON.stringify({ type: "tmux_snapshot", content }));
      }
    } catch {
      // Ignore snapshot errors; next tick will retry.
    } finally {
      snapshotInFlight = false;
    }
  }

  // Send an initial snapshot immediately so the Terminal view populates on load.
  snapshotTick();
  const snapshotTimer = setInterval(snapshotTick, 1000);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (audioTooLarge) return;
      audioBytes += data.length;
      if (audioBytes > MAX_AUDIO_UPLOAD_BYTES) {
        audioChunks = [];
        audioTooLarge = true;
        ws.send(
          JSON.stringify({
            type: "stt_error",
            message: `Audio too large (${audioBytes} bytes). Keep it under ${MAX_AUDIO_UPLOAD_BYTES} bytes.`,
          })
        );
        return;
      }
      audioChunks.push(Buffer.from(data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "audio_start":
        audioChunks = [];
        audioMimeType = msg.mimeType || "audio/webm";
        audioBytes = 0;
        audioTooLarge = false;
        console.log(`[audio] recording started, mimeType=${audioMimeType}`);
        break;

      case "audio_end": {
        if (audioTooLarge) {
          console.log(`[audio] recording dropped for size (${audioBytes} bytes)`);
          audioChunks = [];
          audioBytes = 0;
          audioTooLarge = false;
          break;
        }
        const buf = Buffer.concat(audioChunks);
        console.log(`[audio] recording ended, ${audioChunks.length} chunks, ${buf.length} bytes`);
        handleAudioCommand(buf, audioMimeType);
        audioChunks = [];
        audioBytes = 0;
        break;
      }

      case "audio_cancel": {
        // Client-side cancellation (e.g., Auto Listen toggled off mid-upload).
        audioChunks = [];
        audioBytes = 0;
        audioTooLarge = false;
        console.log(`[audio] recording cancelled${msg.reason ? ` (${msg.reason})` : ""}`);
        break;
      }

      case "text_command":
        if (msg.text && msg.text.trim()) {
          console.log(`[cmd] text: "${msg.text.trim()}"`);
          sendCommand(msg.text.trim());
        }
        break;

      case "status_tab_active":
        statusClients.add(ws);
        console.log(`[status] client activated status tab (${statusClients.size} watching)`);
        if (!statusDaemon.isRunning()) {
          statusDaemon.start(broadcastStatus);
        }
        break;

      case "status_tab_inactive":
        statusClients.delete(ws);
        console.log(`[status] client deactivated status tab (${statusClients.size} watching)`);
        if (statusClients.size === 0 && statusDaemon.isRunning()) {
          statusDaemon.stop();
        }
        break;

      case "pane_send_text":
        if (msg.target && msg.text && msg.text.trim()) {
          try {
            sendTextToPaneTarget(msg.target, msg.text);
            ws.send(JSON.stringify({ type: "pane_action_ok", action: "send_text", target: msg.target }));
          } catch (err) {
            console.error(`[pane_send_text] failed for ${msg.target}: ${err.message}`);
            ws.send(JSON.stringify({ type: "error", message: "Pane send failed: " + err.message }));
          }
        }
        break;

      case "pane_interrupt":
        if (msg.target) {
          (async () => {
            try {
              const repeat = Math.max(1, Math.min(5, Number(msg.times) || 1));
              if (repeat > 1) {
                await sendCtrlCSequenceToPaneTarget(msg.target, { times: repeat, intervalMs: 700 });
              } else {
                sendCtrlCToPaneTarget(msg.target);
              }
              ws.send(JSON.stringify({ type: "pane_action_ok", action: "interrupt", target: msg.target }));
            } catch (err) {
              console.error(`[pane_interrupt] failed for ${msg.target}: ${err.message}`);
              ws.send(JSON.stringify({ type: "error", message: "Pane interrupt failed: " + err.message }));
            }
          })();
        }
        break;

      default:
        console.log(`[ws] unknown message type: ${msg.type}`);
        ws.send(
          JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` })
        );
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    clearInterval(snapshotTimer);
    if (statusClients.delete(ws) && statusClients.size === 0 && statusDaemon.isRunning()) {
      statusDaemon.stop();
    }
  });

  async function handleAudioCommand(audioBuffer, mimeType) {
    try {
      ws.send(JSON.stringify({ type: "transcribing" }));
      const t0 = Date.now();
      const text = await transcribe(audioBuffer, mimeType);
      console.log(`[stt] transcribed in ${Date.now() - t0}ms: "${text}"`);
      if (!text || !text.trim()) {
        console.log("[stt] blank transcription, skipping");
        ws.send(JSON.stringify({ type: "stt_error", message: "No speech detected" }));
        return;
      }
      ws.send(JSON.stringify({ type: "transcription", text }));
      sendCommand("INPUT FROM SPEECH-TO-TEXT (might have transcription errors): " + text);
    } catch (err) {
      console.error("[stt] error:", err.message);
      ws.send(
        JSON.stringify({ type: "stt_error", message: err.message })
      );
    }
  }

  async function sendCommand(text) {
    try {
      await sendToCaptain(text);
      console.log(`[cmd] sent to captain tmux`);
    } catch (err) {
      console.error(`[cmd] failed to send: ${err.message}`);
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to send to captain: " + err.message })
      );
    }
  }
});

(async () => {
  try {
    await loadVoiceSummaryHistory();
    await startInternalSpeakSocket();
    server.listen(PORT, () => {
      console.log(`[voice] server listening on :${PORT}`);
    });
  } catch (err) {
    console.error(`[voice] startup failed: ${err.message}`);
    process.exit(1);
  }
})();
