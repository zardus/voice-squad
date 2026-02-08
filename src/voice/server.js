const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { sendToCaptain, capturePaneOutput } = require("./tmux-bridge");
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

const app = express();

// Static assets don't need auth — the WebSocket is the sensitive part
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Token gate on WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  if (!checkToken(req)) {
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
  console.log("[voice] client connected");

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
    const content = capturePaneOutput();

    // Send snapshot to client if content changed
    if (content !== lastSnapshot) {
      lastSnapshot = content;
      lastSnapshotChangeTime = Date.now();
      ws.send(JSON.stringify({ type: "tmux_snapshot", content }));
      return;
    }

    // When content is stable for 5s and differs from last summary, generate one
    const stableFor = Date.now() - lastSnapshotChangeTime;
    if (stableFor >= SUMMARY_STABLE_MS && content !== lastSummarizedContent && !summarizing) {
      summarizing = true;
      lastSummarizedContent = content;
      try {
        const summary = await summarize(content, lastSummary);
        lastSummary = summary;
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "captain_done", summary }));

          const mp3 = await synthesize(summary);
          ws.send(JSON.stringify({ type: "audio_summary_start" }));
          ws.send(mp3);
          ws.send(JSON.stringify({ type: "audio_summary_end" }));
        }
      } catch (err) {
        console.error("[voice] summary/TTS error:", err.message);
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
        break;

      case "audio_end":
        handleAudioCommand(Buffer.concat(audioChunks), audioMimeType);
        audioChunks = [];
        break;

      case "text_command":
        if (msg.text && msg.text.trim()) {
          sendCommand(msg.text.trim());
        }
        break;

      default:
        ws.send(
          JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` })
        );
    }
  });

  ws.on("close", () => {
    console.log("[voice] client disconnected");
    clearInterval(snapshotTimer);
  });

  async function handleAudioCommand(audioBuffer, mimeType) {
    try {
      const text = await transcribe(audioBuffer, mimeType);
      ws.send(JSON.stringify({ type: "transcription", text }));
      sendCommand(text);
    } catch (err) {
      console.error("[voice] STT error:", err.message);
      ws.send(
        JSON.stringify({ type: "error", message: "Transcription failed: " + err.message })
      );
    }
  }

  function sendCommand(text) {
    try {
      sendToCaptain(text);
    } catch (err) {
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to send to captain: " + err.message })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`[voice] server listening on :${PORT}`);
});
