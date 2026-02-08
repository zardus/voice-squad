const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const { sendToCaptain, capturePaneOutputAsync } = require("./tmux-bridge");
const { transcribe } = require("./stt");
const { synthesize } = require("./tts");
const { summarize } = require("./summarize");

const PORT = process.env.VOICE_PORT || 3000;
const CAPTAIN = process.env.SQUAD_CAPTAIN || "claude";
const TOKEN = process.env.VOICE_TOKEN;

const REQUIRED_ENV = { VOICE_TOKEN: TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
const missing = Object.entries(REQUIRED_ENV).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[voice] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[voice] env OK: VOICE_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY all set");

function checkToken(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get("token") === TOKEN;
}

const STATUS_FILE = "/tmp/squad-status.json";

const app = express();

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

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

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

const SUMMARY_STABLE_MS = 5000;

wss.on("connection", (ws) => {
  console.log("[ws] client connected");

  let audioChunks = [];
  let audioMimeType = "audio/webm";

  ws.send(JSON.stringify({ type: "connected", captain: CAPTAIN }));

  // Snapshot + auto-summary state
  let lastSnapshot = "";
  let lastSnapshotChangeTime = Date.now();
  let lastSummarizedContent = null;
  let lastSummary = "";
  let summarizing = false;

  const snapshotTimer = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return;
    // Skip if the send buffer is backed up (slow connection)
    if (ws.bufferedAmount > 65536) return;
    const content = await capturePaneOutputAsync();

    if (content !== lastSnapshot) {
      lastSnapshot = content;
      lastSnapshotChangeTime = Date.now();
      ws.send(JSON.stringify({ type: "tmux_snapshot", content }));
      return;
    }

    const stableFor = Date.now() - lastSnapshotChangeTime;
    if (stableFor >= SUMMARY_STABLE_MS && content !== lastSummarizedContent && !summarizing) {
      summarizing = true;
      lastSummarizedContent = content;
      const contentLen = content.length;
      console.log(`[summary] terminal stable for ${(stableFor / 1000).toFixed(1)}s, content ${contentLen} chars — summarizing`);
      try {
        const t0 = Date.now();
        const summary = await summarize(content, lastSummary);
        console.log(`[summary] summarize done in ${Date.now() - t0}ms: "${summary.slice(0, 100)}${summary.length > 100 ? "..." : ""}"`);
        lastSummary = summary;
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "captain_done", summary }));

          const t1 = Date.now();
          const audio = await synthesize(summary);
          console.log(`[tts] synthesized ${audio.length} bytes in ${Date.now() - t1}ms`);
          ws.send(audio);
          console.log("[tts] audio sent to client");
        }
      } catch (err) {
        console.error("[summary] error:", err.message);
      }
      summarizing = false;
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
