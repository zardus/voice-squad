if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const terminalEl = document.getElementById("terminal");
const summaryEl = document.getElementById("summary");
const transcriptionEl = document.getElementById("transcription");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");
const updateBtn = document.getElementById("update-btn");
const updateOutput = document.getElementById("update-output");

let ws = null;
let mediaRecorder = null;
let recording = false;
let wantRecording = false; // true while user is holding the mic button
let recordingStartTime = 0;
let micStream = null;
let autoScroll = true;

// Persistent audio element — unlocked on first user gesture so TTS can play later
const ttsAudio = new Audio();
let audioUnlocked = false;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playDing(success) {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    if (success) {
      [660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.2, now + i * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.12);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 280;
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    }
  } catch (e) {}
}

function unlockAudio() {
  if (audioUnlocked) return;
  ttsAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
  ttsAudio.play().then(() => { audioUnlocked = true; }).catch(() => {});
  getAudioContext(); // warm up AudioContext during user gesture
}

function playAudio(data) {
  const blob = new Blob([data], { type: "audio/ogg" });
  const url = URL.createObjectURL(blob);
  if (ttsAudio.src) URL.revokeObjectURL(ttsAudio.src);
  ttsAudio.src = url;
  ttsAudio.play().catch((err) => console.warn("TTS play blocked:", err.message));
}

// Decouple snapshot rendering from WebSocket to keep main thread free
let pendingSnapshot = null;

function renderLoop() {
  if (pendingSnapshot !== null) {
    terminalEl.textContent = pendingSnapshot;
    pendingSnapshot = null;
    if (autoScroll) {
      terminalEl.scrollTop = terminalEl.scrollHeight;
    }
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

const urlParams = new URLSearchParams(location.search);
const token = urlParams.get("token") || "";

terminalEl.addEventListener("scroll", () => {
  const { scrollTop, scrollHeight, clientHeight } = terminalEl;
  autoScroll = scrollHeight - scrollTop - clientHeight < 40;
});

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    statusEl.textContent = "connecting...";
    statusEl.className = "disconnected";
  };

  ws.onmessage = (evt) => {
    // Any binary frame from server = TTS audio, play immediately
    if (evt.data instanceof ArrayBuffer) {
      playAudio(evt.data);
      return;
    }

    const msg = JSON.parse(evt.data);

    switch (msg.type) {
      case "connected":
        statusEl.textContent = msg.captain;
        statusEl.className = "connected";
        break;

      case "tmux_snapshot":
        pendingSnapshot = msg.content;
        break;

      case "captain_done":
        if (msg.summary) {
          summaryEl.textContent = msg.summary;
        }
        break;

      case "transcription":
        transcriptionEl.textContent = msg.text;
        transcriptionEl.className = "";
        break;

      case "stt_error":
        transcriptionEl.textContent = msg.message;
        transcriptionEl.className = "error";
        break;

      case "error":
        summaryEl.textContent = "Error: " + msg.message;
        break;
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "disconnected";
    statusEl.className = "disconnected";
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

// Pre-acquire mic stream so recording starts instantly on press
async function ensureMicStream() {
  if (micStream && micStream.getTracks().some((t) => t.readyState === "live")) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

// Text command
function sendText() {
  unlockAudio();
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text_command", text }));
  textInput.value = "";
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});

// Mic recording — uses pre-acquired stream for instant start
function startRecording() {
  unlockAudio();
  if (!micStream || !micStream.getTracks().some((t) => t.readyState === "live")) {
    // Stream missing or dead — (re)acquire, then start only if user is still holding
    micStream = null;
    ensureMicStream().then(() => {
      if (wantRecording) startRecording();
    }).catch((err) => {
      transcriptionEl.textContent = "Mic access denied: " + err.message;
      transcriptionEl.className = "error";
    });
    return;
  }

  // Don't create a new recorder if one is already active
  if (mediaRecorder && mediaRecorder.state !== "inactive") return;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/mp4";

  mediaRecorder = new MediaRecorder(micStream, { mimeType });
  const recordedChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const held = Date.now() - recordingStartTime;
    if (held < 300) return; // accidental tap — no sound
    if (ws.readyState !== WebSocket.OPEN || recordedChunks.length === 0) {
      playDing(false);
      return;
    }

    // Check total size client-side — don't send tiny phantom recordings
    let totalSize = 0;
    for (const chunk of recordedChunks) totalSize += chunk.size;
    if (totalSize < 1000) {
      playDing(false);
      return;
    }

    playDing(true);
    ws.send(JSON.stringify({ type: "audio_start", mimeType }));
    for (const chunk of recordedChunks) {
      const buf = await chunk.arrayBuffer();
      ws.send(buf);
    }
    ws.send(JSON.stringify({ type: "audio_end" }));
  };

  mediaRecorder.start(250);
  recording = true;
  recordingStartTime = Date.now();
  micBtn.classList.add("recording");
}

function stopRecording() {
  wantRecording = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recording = false;
  micBtn.classList.remove("recording");
}

// Track last touch time to ignore synthesized mouse events on mobile
let lastTouchTime = 0;

micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  lastTouchTime = Date.now();
  wantRecording = true;
  startRecording();
});
micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});
micBtn.addEventListener("touchcancel", () => {
  if (recording || wantRecording) stopRecording();
});

micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (Date.now() - lastTouchTime < 1000) return; // ignore synthesized mouse event
  wantRecording = true;
  startRecording();
});
micBtn.addEventListener("mouseup", () => {
  if (Date.now() - lastTouchTime < 1000) return;
  stopRecording();
});
micBtn.addEventListener("mouseleave", () => {
  if (Date.now() - lastTouchTime < 1000) return;
  if (recording || wantRecording) stopRecording();
});

// Pre-acquire mic on first user interaction anywhere
document.addEventListener("touchstart", () => ensureMicStream().catch(() => {}), { once: true });
document.addEventListener("click", () => ensureMicStream().catch(() => {}), { once: true });

// Update button
updateBtn.addEventListener("click", async () => {
  if (updateBtn.classList.contains("running")) return;
  updateBtn.classList.add("running");
  updateBtn.textContent = "Updating...";
  updateOutput.textContent = "";
  updateOutput.className = "visible";
  try {
    const res = await fetch(`/api/update?token=${encodeURIComponent(token)}`, { method: "POST" });
    const data = await res.json();
    updateOutput.textContent = data.output || data.error || "No output";
    updateOutput.className = data.ok ? "visible" : "visible error";
  } catch (err) {
    updateOutput.textContent = "Request failed: " + err.message;
    updateOutput.className = "visible error";
  }
  updateBtn.classList.remove("running");
  updateBtn.textContent = "Update";
});

connect();
