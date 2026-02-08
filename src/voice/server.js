const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const { sendToCaptain, capturePaneOutputAsync } = require("./tmux-bridge");
const { transcribe } = require("./stt");
const { synthesize } = require("./tts");
const statusDaemon = require("./status-daemon");

const PORT = process.env.VOICE_PORT || 3000;
const CAPTAIN = process.env.SQUAD_CAPTAIN || "claude";
const TOKEN = process.env.VOICE_TOKEN;

const REQUIRED_ENV = { VOICE_TOKEN: TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
const missing = Object.entries(REQUIRED_ENV).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[voice] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[voice] env OK: VOICE_TOKEN, OPENAI_API_KEY all set");

function checkToken(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get("token") === TOKEN;
}

const STATUS_FILE = "/tmp/squad-status.json";

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get("token") !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const data = fs.readFileSync(STATUS_FILE, "utf8");
    res.json(JSON.parse(data));
  } catch {
    res.json({ timestamp: null, summary: "Status daemon not running yet.", paneCount: 0, sessions: [] });
  }
});

app.post("/api/speak", async (req, res) => {
  const { text, token } = req.body || {};
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Missing or empty 'text' field" });
  }
  try {
    const trimmed = text.trim();
    console.log(`[speak] "${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}"`);
    const audio = await synthesize(trimmed);
    console.log(`[speak] synthesized ${audio.length} bytes`);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "speak_text", text: trimmed }));
        client.send(audio);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[speak] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Track clients with the status tab active
const statusClients = new Set();

function broadcastStatus(data) {
  const msg = JSON.stringify({ type: "status_update", ...data });
  for (const client of statusClients) {
    if (client.readyState === 1) {
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

wss.on("connection", (ws) => {
  console.log("[ws] client connected");

  let audioChunks = [];
  let audioMimeType = "audio/webm";

  ws.send(JSON.stringify({ type: "connected", captain: CAPTAIN }));

  let lastSnapshot = "";

  const snapshotTimer = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 65536) return;
    const content = await capturePaneOutputAsync();

    if (content !== lastSnapshot) {
      lastSnapshot = content;
      ws.send(JSON.stringify({ type: "tmux_snapshot", content }));
    }
  }, 1000);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
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
        console.log(`[audio] recording started, mimeType=${audioMimeType}`);
        break;

      case "audio_end": {
        const buf = Buffer.concat(audioChunks);
        console.log(`[audio] recording ended, ${audioChunks.length} chunks, ${buf.length} bytes`);
        handleAudioCommand(buf, audioMimeType);
        audioChunks = [];
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
      const t0 = Date.now();
      const text = await transcribe(audioBuffer, mimeType);
      console.log(`[stt] transcribed in ${Date.now() - t0}ms: "${text}"`);
      ws.send(JSON.stringify({ type: "transcription", text }));
      sendCommand("INPUT FROM SPEECH-TO-TEXT (might have transcription errors): " + text);
    } catch (err) {
      console.error("[stt] error:", err.message);
      ws.send(
        JSON.stringify({ type: "stt_error", message: err.message })
      );
    }
  }

  function sendCommand(text) {
    try {
      sendToCaptain(text);
      console.log(`[cmd] sent to captain tmux`);
    } catch (err) {
      console.error(`[cmd] failed to send: ${err.message}`);
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to send to captain: " + err.message })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`[voice] server listening on :${PORT}`);
});
