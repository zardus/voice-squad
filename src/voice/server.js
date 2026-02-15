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
let CAPTAIN = process.env.SQUAD_CAPTAIN || "claude";
const TOKEN = process.env.VOICE_TOKEN;
const CAPTAIN_DIR = process.env.SQUAD_CAPTAIN_DIR || path.join(os.homedir(), "captain");
const ARCHIVE_DIR = process.env.SQUAD_ARCHIVE_DIR || path.join(CAPTAIN_DIR, "archive");
const TASK_DEFS_DIR = process.env.SQUAD_TASK_DEFS_DIR || path.join(CAPTAIN_DIR, "task-definitions");
const TASK_DEFS_PENDING_DIR = path.join(TASK_DEFS_DIR, "pending");
const TASK_DEFS_ARCHIVED_DIR = path.join(TASK_DEFS_DIR, "archived");
const SUMMARIES_DIR = process.env.SQUAD_SUMMARIES_DIR || path.join(ARCHIVE_DIR, "summaries");
const COMPLETED_TASKS_LIMIT = Number(process.env.SQUAD_COMPLETED_TASKS_LIMIT || process.env.COMPLETED_TASKS_LIMIT || 2000);
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64 * 1024 * 1024);
const MAX_AUDIO_UPLOAD_BYTES = Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 64 * 1024 * 1024);
const VOICE_HISTORY_FILE = process.env.VOICE_HISTORY_FILE || "/tmp/voice-summary-history.json";
const VOICE_HISTORY_LIMIT = Number(process.env.VOICE_HISTORY_LIMIT || 1000);

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

function fileTimestampFromIso(isoLike) {
  const dt = isoLike ? new Date(isoLike) : new Date();
  const safeDate = Number.isFinite(dt.valueOf()) ? dt : new Date();
  return safeDate.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function completedAtToEpoch(item) {
  const t = Date.parse(item.completed_at || "");
  return Number.isFinite(t) ? t : 0;
}

function isoNoMillis(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.valueOf())) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function listExplicitCompletedTasks() {
  try {
    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
  } catch (err) {
    // If the directory is unreadable/uncreatable, fall back to inferred tasks.
    console.warn(`[completed-tasks] cannot access summaries dir ${SUMMARIES_DIR}: ${err.message}`);
    return [];
  }

  let entries = [];
  try {
    entries = await fs.readdir(SUMMARIES_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[completed-tasks] cannot read summaries dir ${SUMMARIES_DIR}: ${err.message}`);
    return [];
  }

  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(SUMMARIES_DIR, entry.name);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      tasks.push(parsed);
    } catch (err) {
      console.warn(`[completed-tasks] skipping ${entry.name}: ${err.message}`);
    }
  }
  tasks.sort((a, b) => completedAtToEpoch(b) - completedAtToEpoch(a));
  return tasks;
}

function parseArchiveLogName(filename) {
  // Expected: <session>_<window>_<YYYY-MM-DD>_<HH-MM-SS>.log
  // Window names can contain underscores; session names typically don't, but be defensive.
  if (typeof filename !== "string" || !filename.endsWith(".log")) return null;
  const base = filename.slice(0, -".log".length);
  const parts = base.split("_");
  if (parts.length < 4) return null;

  const timePart = parts[parts.length - 1];
  const datePart = parts[parts.length - 2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || !/^\d{2}-\d{2}-\d{2}$/.test(timePart)) {
    return null;
  }

  const nameParts = parts.slice(0, -2);
  if (nameParts.length < 2) return null;
  const session = nameParts[0];
  const windowName = nameParts.slice(1).join("_");

  return { session, window: windowName };
}

async function readTaskDefinition(windowName) {
  const name = String(windowName || "").trim();
  if (!name) return null;

  const candidates = [
    path.join(TASK_DEFS_ARCHIVED_DIR, `${name}.txt`),
    path.join(TASK_DEFS_PENDING_DIR, `${name}.txt`),
  ];

  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    } catch {}
  }
  return null;
}

async function listInferredCompletedTasksFromArchiveLogs() {
  let entries = [];
  try {
    entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
  } catch (err) {
    // Archive directory might not exist in some setups; don't fail the endpoint.
    console.warn(`[completed-tasks] cannot read archive dir ${ARCHIVE_DIR}: ${err.message}`);
    return [];
  }

  const logFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".log"))
    .map((e) => e.name);

  const latestByTarget = new Map();

  for (const name of logFiles) {
    const parsed = parseArchiveLogName(name);
    if (!parsed) continue;
    const fullPath = path.join(ARCHIVE_DIR, name);

    let st;
    try {
      st = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const key = `${parsed.session}:${parsed.window}`;
    const existing = latestByTarget.get(key);
    if (!existing || (st.mtimeMs || 0) > existing.mtimeMs) {
      latestByTarget.set(key, {
        ...parsed,
        mtimeMs: st.mtimeMs || 0,
        log_file: name,
      });
    }
  }

  const inferred = Array.from(latestByTarget.values())
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

  const out = [];
  for (const item of inferred) {
    const completedAt = item.mtimeMs ? isoNoMillis(new Date(item.mtimeMs)) : null;
    out.push({
      task_name: item.window,
      completed_at: completedAt,
      short_summary: "Completed (inferred from archived pane log; missing explicit completion record).",
      worker_type: "unknown",
      session: item.session,
      window: item.window,
      archive_log: item.log_file,
      task_definition: await readTaskDefinition(item.window),
    });
  }

  return out;
}

async function listCompletedTasks() {
  const explicit = await listExplicitCompletedTasks();
  const inferred = await listInferredCompletedTasksFromArchiveLogs();

  // Merge on strongest identity available: session+window if present, else task_name.
  const mergedByKey = new Map();
  const add = (task) => {
    if (!task || typeof task !== "object") return;
    const session = typeof task.session === "string" ? task.session : "";
    const windowName = typeof task.window === "string" ? task.window : "";
    const taskName = typeof task.task_name === "string" ? task.task_name : "";
    const key = (session && windowName) ? `${session}:${windowName}` : `name:${taskName}`;
    if (!key || key === "name:") return;

    const prev = mergedByKey.get(key);
    if (!prev) {
      mergedByKey.set(key, task);
      return;
    }

    // Prefer the one with the newest completed_at, but keep richer fields.
    const prevEpoch = completedAtToEpoch(prev);
    const nextEpoch = completedAtToEpoch(task);
    const newest = nextEpoch >= prevEpoch ? task : prev;
    const oldest = newest === task ? prev : task;
    mergedByKey.set(key, { ...oldest, ...newest });
  };

  for (const t of inferred) add(t);
  for (const t of explicit) add(t);

  const merged = Array.from(mergedByKey.values());
  merged.sort((a, b) => completedAtToEpoch(b) - completedAtToEpoch(a));

  if (Number.isFinite(COMPLETED_TASKS_LIMIT) && COMPLETED_TASKS_LIMIT > 0) {
    return merged.slice(0, COMPLETED_TASKS_LIMIT);
  }
  return merged;
}

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

  const completedAt = summary.completed_at && typeof summary.completed_at === "string"
    ? summary.completed_at
    : new Date().toISOString();
  const finalSummary = { ...summary, completed_at: completedAt };

  try {
    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    const baseName = `${fileTimestampFromIso(finalSummary.completed_at)}_${sanitizeTaskName(finalSummary.task_name)}`;
    let candidate = `${baseName}.json`;
    let suffix = 1;
    while (true) {
      try {
        await fs.access(path.join(SUMMARIES_DIR, candidate));
        candidate = `${baseName}_${suffix}.json`;
        suffix++;
      } catch {
        break;
      }
    }

    await fs.writeFile(
      path.join(SUMMARIES_DIR, candidate),
      JSON.stringify(finalSummary, null, 2) + "\n",
      "utf8"
    );
    res.status(201).json({ ok: true, file: candidate });
  } catch (err) {
    console.error("[completed-tasks] POST error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/speak", async (req, res) => {
  const { text, token, playbackOnly, format } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
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
});

app.post("/api/interrupt", (req, res) => {
  const { token } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // Some captain runs need multiple SIGINT attempts before returning to prompt.
    for (let i = 0; i < 3; i++) {
      execSync("tmux send-keys -t %0 C-c", { timeout: 5000 });
    }
    console.log("[interrupt] sent Ctrl+C x3 to captain pane %0");
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

  const { exec } = require("child_process");
  restartInProgress = true;

  console.log(`[restart] launching restart-captain.sh ${tool}...`);
  try {
    // Wait for the restart script to finish so we can report real success/failure
    const output = await new Promise((resolve, reject) => {
      exec(
        `/opt/squad/restart-captain.sh ${tool}`,
        { timeout: 60000 },
        (err, stdout, stderr) => {
          const combined = (stdout + stderr).trim();
          if (err) {
            reject(new Error(combined || err.message));
          } else {
            resolve(combined);
          }
        }
      );
    });
    console.log(`[restart] restart-captain.sh completed for ${tool}`);
    CAPTAIN = tool;
    res.json({ ok: true, tool });
  } catch (err) {
    console.error(`[restart] restart-captain.sh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    restartInProgress = false;
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
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

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

loadVoiceSummaryHistory().finally(() => {
  server.listen(PORT, () => {
    console.log(`[voice] server listening on :${PORT}`);
  });
});
