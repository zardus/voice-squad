const terminalEl = document.getElementById("terminal");
const summaryEl = document.getElementById("summary");
const transcriptionEl = document.getElementById("transcription");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");
const updateBtn = document.getElementById("update-btn");
const autoreadCb = document.getElementById("autoread-cb");
const voiceMicBtn = document.getElementById("voice-mic-btn");
const voiceReplayBtn = document.getElementById("voice-replay-btn");
const voiceStatusBtn = document.getElementById("voice-status-btn");
const controlsEl = document.getElementById("controls");
let lastTtsAudioData = null;

// Auto-read toggle: OFF by default, persisted in localStorage
let autoreadBeforeVoice = null; // saved state when entering Voice tab
autoreadCb.checked = localStorage.getItem("autoread") === "true";
autoreadCb.addEventListener("change", () => {
  localStorage.setItem("autoread", autoreadCb.checked);
});

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
    // Re-send status tab state on reconnect
    if (statusTabActive) {
      ws.send(JSON.stringify({ type: "status_tab_active" }));
    }
  };

  ws.onmessage = (evt) => {
    // Any binary frame from server = TTS audio, store for replay and play if auto-read is on
    if (evt.data instanceof ArrayBuffer) {
      lastTtsAudioData = evt.data;
      voiceReplayBtn.disabled = false;
      if (autoreadCb.checked) playAudio(evt.data);
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

      case "speak_text":
        if (msg.text) {
          summaryEl.textContent = msg.text;
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

      case "status_update":
        renderStatus(msg);
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
  voiceMicBtn.classList.add("recording");
}

function stopRecording() {
  wantRecording = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recording = false;
  micBtn.classList.remove("recording");
  voiceMicBtn.classList.remove("recording");
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

// Voice tab mic button — mirrors main mic button behavior
voiceMicBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  lastTouchTime = Date.now();
  wantRecording = true;
  startRecording();
});
voiceMicBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});
voiceMicBtn.addEventListener("touchcancel", () => {
  if (recording || wantRecording) stopRecording();
});
voiceMicBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (Date.now() - lastTouchTime < 1000) return;
  wantRecording = true;
  startRecording();
});
voiceMicBtn.addEventListener("mouseup", () => {
  if (Date.now() - lastTouchTime < 1000) return;
  stopRecording();
});
voiceMicBtn.addEventListener("mouseleave", () => {
  if (Date.now() - lastTouchTime < 1000) return;
  if (recording || wantRecording) stopRecording();
});

// Replay button — plays last TTS audio
voiceReplayBtn.addEventListener("click", () => {
  if (lastTtsAudioData) playAudio(lastTtsAudioData);
});

// Voice status button — ask captain for a task status update
voiceStatusBtn.addEventListener("click", () => {
  unlockAudio();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text_command", text: "Give me a status update on all the tasks" }));
});

// Pre-acquire mic on first user interaction anywhere
document.addEventListener("touchstart", () => ensureMicStream().catch(() => {}), { once: true });
document.addEventListener("click", () => ensureMicStream().catch(() => {}), { once: true });

// Status button — ask captain for a task status update
updateBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text_command", text: "Give me a status update on all the tasks" }));
});

// --- Tab switching ---
const tabs = document.querySelectorAll("#tab-bar .tab");
const tabContents = document.querySelectorAll(".tab-content");

let statusTabActive = false;

function sendStatusTabState(active) {
  statusTabActive = active;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: active ? "status_tab_active" : "status_tab_inactive" }));
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    const wasVoice = document.getElementById("voice-view").classList.contains("active");
    const wasStatus = document.getElementById("status-view").classList.contains("active");
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    tabContents.forEach((c) => {
      c.classList.toggle("active", c.id === target + "-view");
    });
    // Notify server about status tab activation/deactivation
    if (target === "status" && !wasStatus) sendStatusTabState(true);
    if (target !== "status" && wasStatus) sendStatusTabState(false);
    // Voice tab: force auto-read on, hide controls
    if (target === "voice") {
      autoreadBeforeVoice = autoreadCb.checked;
      autoreadCb.checked = true;
      controlsEl.classList.add("hidden");
    } else {
      controlsEl.classList.remove("hidden");
      if (wasVoice && autoreadBeforeVoice !== null) {
        autoreadCb.checked = autoreadBeforeVoice;
        autoreadBeforeVoice = null;
      }
    }
  });
});

// --- Status tab ---
const statusTimeEl = document.getElementById("status-time");
const statusSummaryEl = document.getElementById("status-summary");
const statusPanesEl = document.getElementById("status-panes");

let lastStatusTimestamp = null;

function relativeTime(isoString) {
  if (!isoString) return "never";
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function updateRelativeTime() {
  if (lastStatusTimestamp) {
    statusTimeEl.textContent = relativeTime(lastStatusTimestamp);
  }
}

function mdToHtml(md) {
  if (!md) return "";
  const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc.split("\n");
  const out = [];
  let inUl = false;
  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      const tag = "h" + Math.min(headerMatch[1].length + 1, 4); // ## -> h3, ### -> h4
      out.push(`<${tag}>${inline(headerMatch[2])}</${tag}>`);
      continue;
    }
    const liMatch = line.match(/^[-*]\s+(.+)$/);
    if (liMatch) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(liMatch[1])}</li>`);
      continue;
    }
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (line.trim() === "") {
      out.push("<br>");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inUl) out.push("</ul>");
  return out.join("");

  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
}

function renderStatus(data) {
  lastStatusTimestamp = data.timestamp;
  statusTimeEl.textContent = data.timestamp ? relativeTime(data.timestamp) : "waiting...";
  statusSummaryEl.innerHTML = mdToHtml(data.summary);

  statusPanesEl.innerHTML = "";
  if (data.sessions && data.sessions.length) {
    for (const session of data.sessions) {
      for (const win of session.windows) {
        const details = document.createElement("details");
        details.className = "pane-details";

        const summary = document.createElement("summary");
        summary.textContent = `${session.name} / ${win.name}`;
        details.appendChild(summary);

        const pre = document.createElement("pre");
        pre.className = "pane-snippet";
        pre.textContent = win.snippet;
        details.appendChild(pre);

        statusPanesEl.appendChild(details);
      }
    }
  }
}

async function fetchStatus() {
  try {
    const resp = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
    if (resp.ok) {
      const data = await resp.json();
      renderStatus(data);
    }
  } catch (e) {
    // ignore fetch errors
  }
}

// Update relative time every second
setInterval(updateRelativeTime, 1000);

connect();
