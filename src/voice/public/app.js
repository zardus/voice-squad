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
const voiceTranscriptionEl = document.getElementById("voice-transcription");
const voiceInterruptBtn = document.getElementById("voice-interrupt-btn");
const voiceHistorySelect = document.getElementById("voice-history-select");
const voiceOutputHistorySelect = document.getElementById("voice-output-history-select");
const interruptBtn = document.getElementById("interrupt-btn");
const controlsEl = document.getElementById("controls");
const captainToolSelect = document.getElementById("captain-tool-select");
const restartCaptainBtn = document.getElementById("restart-captain-btn");
const voiceCaptainToolSelect = document.getElementById("voice-captain-tool-select");
const voiceRestartCaptainBtn = document.getElementById("voice-restart-captain-btn");
const completedTabContentEl = document.getElementById("completed-tab-content");
const refreshCompletedBtn = document.getElementById("refresh-completed-btn");
let lastTtsAudioData = null;
let speakAudioQueue = []; // TTS audio received while mic is held down

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
let disconnectedFlashTimer = null;
let maxRecordingTimer = null;

const MIN_RECORDING_MS = 300;
const MIN_AUDIO_BYTES = 1000;
const MEDIARECORDER_TIMESLICE_MS = 250;
const MAX_RECORDING_MS = 10 * 60 * 1000; // 10 minutes
const WS_AUDIO_FRAME_BYTES = 64 * 1024;

// Persistent audio element — unlocked on first user gesture so TTS can play later
const ttsAudio = new Audio();
let audioUnlocked = false;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playChime() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    // Pleasant bell: a short sine at 830 Hz with a gentle decay
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(830, now);
    osc.frequency.exponentialRampToValueAtTime(790, now + 0.3);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch (e) {}
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
  // Resume AudioContext if suspended (mobile browsers suspend on background)
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
const MESSAGE_HISTORY_KEY = "message_history";
const SPEAK_HISTORY_KEY = "speak_history";
const MESSAGE_HISTORY_LIMIT = 20;
const SPEAK_HISTORY_LIMIT = 20;
const HISTORY_PREVIEW_MAX = 40;
let messageHistory = [];
let speakHistory = [];

function truncateHistoryPreview(text) {
  return text.length > HISTORY_PREVIEW_MAX
    ? text.slice(0, HISTORY_PREVIEW_MAX - 3) + "..."
    : text;
}

function loadMessageHistory() {
  try {
    const raw = localStorage.getItem(MESSAGE_HISTORY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    messageHistory = parsed
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MESSAGE_HISTORY_LIMIT);
  } catch {
    messageHistory = [];
  }
}

function persistMessageHistory() {
  try {
    localStorage.setItem(MESSAGE_HISTORY_KEY, JSON.stringify(messageHistory));
  } catch {}
}

function renderMessageHistorySelect() {
  if (!voiceHistorySelect) return;
  while (voiceHistorySelect.options.length > 1) {
    voiceHistorySelect.remove(1);
  }
  for (const message of messageHistory) {
    const option = document.createElement("option");
    option.value = message;
    option.textContent = truncateHistoryPreview(message);
    option.title = message;
    voiceHistorySelect.appendChild(option);
  }
  voiceHistorySelect.value = "";
}

function addMessageToHistory(text) {
  const normalized = (text || "").trim();
  if (!normalized) return;
  if (messageHistory[0] === normalized) return;
  messageHistory.unshift(normalized);
  if (messageHistory.length > MESSAGE_HISTORY_LIMIT) {
    messageHistory.length = MESSAGE_HISTORY_LIMIT;
  }
  persistMessageHistory();
  renderMessageHistorySelect();
}

function sendTextCommand(text, opts = {}) {
  const trimmed = (text || "").trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: "text_command", text: trimmed }));
  if (opts.trackHistory !== false) addMessageToHistory(trimmed);
  return true;
}

function loadSpeakHistory() {
  try {
    const raw = localStorage.getItem(SPEAK_HISTORY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    speakHistory = parsed
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, SPEAK_HISTORY_LIMIT);
  } catch {
    speakHistory = [];
  }
}

function persistSpeakHistory() {
  try {
    localStorage.setItem(SPEAK_HISTORY_KEY, JSON.stringify(speakHistory));
  } catch {}
}

function renderSpeakHistorySelect() {
  if (!voiceOutputHistorySelect) return;
  while (voiceOutputHistorySelect.options.length > 1) {
    voiceOutputHistorySelect.remove(1);
  }
  for (const message of speakHistory) {
    const option = document.createElement("option");
    option.value = message;
    option.textContent = truncateHistoryPreview(message);
    option.title = message;
    voiceOutputHistorySelect.appendChild(option);
  }
  voiceOutputHistorySelect.value = "";
}

function addSpeakToHistory(text) {
  const normalized = (text || "").trim();
  if (!normalized) return;
  if (speakHistory[0] === normalized) return;
  speakHistory.unshift(normalized);
  if (speakHistory.length > SPEAK_HISTORY_LIMIT) {
    speakHistory.length = SPEAK_HISTORY_LIMIT;
  }
  persistSpeakHistory();
  renderSpeakHistorySelect();
}

async function requestSpeak(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  try {
    const resp = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text: trimmed }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

loadMessageHistory();
loadSpeakHistory();

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
    // Re-send screens tab state on reconnect
    if (screensTabActive) {
      ws.send(JSON.stringify({ type: "status_tab_active" }));
    }
  };

  ws.onmessage = (evt) => {
    // Any binary frame from server = TTS audio, store for replay and play
    if (evt.data instanceof ArrayBuffer) {
      lastTtsAudioData = evt.data;
      voiceReplayBtn.disabled = false;
      // Respect the auto-read toggle for autoplay; replay is always available.
      const shouldPlay = autoreadCb.checked;
      if (shouldPlay) {
        if (recording || wantRecording) {
          // Mic is active — hold audio until recording stops
          speakAudioQueue.push(evt.data);
        } else {
          playAudio(evt.data);
        }
      }
      return;
    }

    const msg = JSON.parse(evt.data);

    switch (msg.type) {
      case "connected":
        statusEl.textContent = msg.captain;
        statusEl.className = "connected";
        if (msg.captain === "claude" || msg.captain === "codex") {
          captainToolSelect.value = msg.captain;
          voiceCaptainToolSelect.value = msg.captain;
          updateSelectColors();
        }
        break;

      case "tmux_snapshot":
        pendingSnapshot = msg.content;
        break;

      case "speak_text":
        if (msg.text) {
          summaryEl.textContent = msg.text;
          addSpeakToHistory(msg.text);
        }
        break;

      case "transcription":
        transcriptionEl.textContent = msg.text;
        transcriptionEl.className = "";
        voiceTranscriptionEl.textContent = "Sent";
        voiceTranscriptionEl.className = "voice-transcription";
        addMessageToHistory(msg.text);
        break;

      case "transcribing":
        showTranscribingIndicator();
        break;

      case "stt_error":
        transcriptionEl.textContent = msg.message;
        transcriptionEl.className = "error";
        voiceTranscriptionEl.textContent = "Error";
        voiceTranscriptionEl.className = "voice-transcription error";
        playDing(false);
        break;

      case "status_stream_update":
        renderStreamUpdate(msg);
        break;

      case "error":
        summaryEl.textContent = "Error: " + msg.message;
        break;
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "disconnected";
    statusEl.className = "disconnected";
    // Reset audio unlock so next user gesture re-primes the Audio element
    audioUnlocked = false;
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
  if (!text) return;
  if (!sendTextCommand(text)) return;
  textInput.value = "";
}

function flashDisconnectedIndicator() {
  transcriptionEl.textContent = "Disconnected";
  transcriptionEl.className = "error";
  voiceTranscriptionEl.textContent = "Disconnected";
  voiceTranscriptionEl.className = "voice-transcription error";
  if (disconnectedFlashTimer) clearTimeout(disconnectedFlashTimer);
  disconnectedFlashTimer = setTimeout(() => {
    if (transcriptionEl.textContent === "Disconnected") {
      transcriptionEl.textContent = "";
      transcriptionEl.className = "";
    }
    if (voiceTranscriptionEl.textContent === "Disconnected") {
      voiceTranscriptionEl.textContent = "";
      voiceTranscriptionEl.className = "voice-transcription";
    }
  }, 1200);
}

function showTranscribingIndicator() {
  transcriptionEl.textContent = "Transcribing...";
  transcriptionEl.className = "transcribing";
  voiceTranscriptionEl.textContent = "Transcribing...";
  voiceTranscriptionEl.className = "voice-transcription transcribing";
}

function showUploadingIndicator(pct = 0) {
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const text = `Uploading... ${safePct}%`;
  transcriptionEl.textContent = text;
  transcriptionEl.className = "transcribing";
  voiceTranscriptionEl.textContent = text;
  voiceTranscriptionEl.className = "voice-transcription transcribing";
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});

if (voiceHistorySelect) {
  voiceHistorySelect.addEventListener("change", () => {
    const text = voiceHistorySelect.value;
    if (!text) return;
    if (sendTextCommand(text)) {
      playDing(true);
    } else {
      playDing(false);
    }
    voiceHistorySelect.value = "";
  });
}

if (voiceOutputHistorySelect) {
  voiceOutputHistorySelect.addEventListener("change", async () => {
    const text = voiceOutputHistorySelect.value;
    if (!text) return;
    const ok = await requestSpeak(text);
    playDing(ok);
    voiceOutputHistorySelect.value = "";
  });
}

// Mic recording — uses pre-acquired stream for instant start
function startRecording() {
  unlockAudio();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    wantRecording = false;
    playDing(false);
    flashDisconnectedIndicator();
    return;
  }

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
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    const held = Date.now() - recordingStartTime;
    if (held < MIN_RECORDING_MS) return; // accidental tap — no sound
    if (ws.readyState !== WebSocket.OPEN || recordedChunks.length === 0) {
      playDing(false);
      return;
    }

    // Check total size client-side — don't send tiny phantom recordings
    let totalSize = 0;
    for (const chunk of recordedChunks) totalSize += chunk.size;
    if (totalSize < MIN_AUDIO_BYTES) {
      playDing(false);
      return;
    }

    // Show upload feedback first; switch to "Transcribing..." when server confirms STT started.
    showUploadingIndicator(0);
    playDing(true);
    ws.send(JSON.stringify({ type: "audio_start", mimeType }));

    // This is "upload" over WebSocket. We can't observe actual network send progress, but
    // we can report how much audio data we've queued into the WS socket buffer.
    let totalBytes = 0;
    for (const chunk of recordedChunks) totalBytes += chunk.size;
    if (totalBytes <= 0) totalBytes = 1;

    let sentBytes = 0;
    let lastPct = -1;
    let lastUiUpdate = 0;
    const maybeUpdatePct = (force = false) => {
      const pct = Math.round((sentBytes / totalBytes) * 100);
      const now = Date.now();
      if (!force) {
        // Throttle DOM updates to keep UI responsive.
        if (pct === lastPct) return;
        if (now - lastUiUpdate < 60 && pct < 100) return;
      }
      lastPct = pct;
      lastUiUpdate = now;
      showUploadingIndicator(pct);
    };

    for (const chunk of recordedChunks) {
      const chunkBytes = new Uint8Array(await chunk.arrayBuffer());
      for (let offset = 0; offset < chunkBytes.byteLength; offset += WS_AUDIO_FRAME_BYTES) {
        const frame = chunkBytes.slice(offset, offset + WS_AUDIO_FRAME_BYTES);
        ws.send(frame);
        sentBytes += frame.byteLength;
        maybeUpdatePct(false);
      }
    }
    sentBytes = totalBytes;
    maybeUpdatePct(true);
    ws.send(JSON.stringify({ type: "audio_end" }));
  };

  mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);
  recording = true;
  recordingStartTime = Date.now();
  if (maxRecordingTimer) clearTimeout(maxRecordingTimer);
  maxRecordingTimer = setTimeout(() => {
    if (recording || wantRecording) stopRecording();
  }, MAX_RECORDING_MS);
  micBtn.classList.add("recording");
  voiceMicBtn.classList.add("recording");
}

function stopRecording() {
  wantRecording = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }
  recording = false;
  micBtn.classList.remove("recording");
  voiceMicBtn.classList.remove("recording");

  // Play the most recent speak audio that arrived while recording.
  // Only the latest is played to avoid a cascade of stale messages.
  // Audio in the queue already passed the shouldPlay check when it was queued.
  if (speakAudioQueue.length > 0) {
    const latest = speakAudioQueue[speakAudioQueue.length - 1];
    speakAudioQueue = [];
    playAudio(latest);
  }
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

// Spacebar hold-to-record (Voice tab only, not when typing in text input)
let spacebarHeld = false;

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (!document.getElementById("voice-view").classList.contains("active")) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  e.preventDefault();
  if (spacebarHeld) return; // guard against key repeat
  spacebarHeld = true;
  wantRecording = true;
  startRecording();
});

document.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  if (!spacebarHeld) return;
  e.preventDefault();
  spacebarHeld = false;
  stopRecording();
});

// Replay button — plays last TTS audio
voiceReplayBtn.addEventListener("click", () => {
  audioUnlocked = true; // prevent document click handler from overwriting src
  if (lastTtsAudioData) playAudio(lastTtsAudioData);
});

// Voice status button — ask captain for a task status update
voiceStatusBtn.addEventListener("click", () => {
  audioUnlocked = true; // prevent document click handler from overwriting src
  playDing(true);
  sendTextCommand("Give me a status update on all the tasks");
});

// Unlock audio + acquire mic on user interaction.
// Not once-only: after WS reconnect audioUnlocked resets, so we need subsequent
// gestures to re-prime the Audio element for autoplay.
let micStreamAcquired = false;
function onUserGesture() {
  if (!audioUnlocked) unlockAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  if (!micStreamAcquired) {
    ensureMicStream().then(() => { micStreamAcquired = true; }).catch(() => {});
  }
}
document.addEventListener("touchstart", onUserGesture, { passive: true });
document.addEventListener("click", onUserGesture);

// Status button — ask captain for a task status update
updateBtn.addEventListener("click", () => {
  sendTextCommand("Give me a status update on all the tasks");
});

// Interrupt — send Ctrl+C to captain
async function sendInterrupt() {
  try {
    const resp = await fetch("/api/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (resp.ok) {
      playDing(true);
    } else {
      playDing(false);
    }
  } catch {
    playDing(false);
  }
}

interruptBtn.addEventListener("click", sendInterrupt);
voiceInterruptBtn.addEventListener("click", sendInterrupt);

// Restart captain — switch between Claude and Codex
function syncCaptainSelects(source) {
  const val = source.value;
  captainToolSelect.value = val;
  voiceCaptainToolSelect.value = val;
  updateSelectColors();
}

function updateSelectColors() {
  [captainToolSelect, voiceCaptainToolSelect].forEach((sel) => {
    sel.classList.toggle("claude-selected", sel.value === "claude");
    sel.classList.toggle("codex-selected", sel.value === "codex");
  });
}

captainToolSelect.addEventListener("change", () => syncCaptainSelects(captainToolSelect));
voiceCaptainToolSelect.addEventListener("change", () => syncCaptainSelects(voiceCaptainToolSelect));
updateSelectColors();

async function restartCaptain() {
  const tool = captainToolSelect.value;
  const btns = [restartCaptainBtn, voiceRestartCaptainBtn];
  btns.forEach((b) => { b.disabled = true; b.textContent = "Restarting..."; });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const resp = await fetch("/api/restart-captain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tool }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      playDing(true);
      statusEl.textContent = tool;
      summaryEl.textContent = "Captain restarted (" + tool + ")";
    } else {
      const data = await resp.json().catch(() => ({}));
      const errMsg = data.error || "Restart failed (HTTP " + resp.status + ")";
      playDing(false);
      summaryEl.textContent = "Restart error: " + errMsg;
    }
  } catch (err) {
    clearTimeout(timeout);
    playDing(false);
    if (err.name === "AbortError") {
      summaryEl.textContent = "Restart timed out — captain may still be restarting";
    } else {
      summaryEl.textContent = "Restart failed: " + (err.message || "network error");
    }
  } finally {
    restartCaptainBtn.textContent = "Restart";
    voiceRestartCaptainBtn.textContent = "Restart Captain";
    btns.forEach((b) => { b.disabled = false; });
  }
}

restartCaptainBtn.addEventListener("click", restartCaptain);
voiceRestartCaptainBtn.addEventListener("click", restartCaptain);

// --- Tab switching ---
const tabs = document.querySelectorAll("#tab-bar .tab");
const tabContents = document.querySelectorAll(".tab-content");
const tabBarEl = document.getElementById("tab-bar");

let screensTabActive = false;

let activePaneInteract = null; // { key, panel, overlay, input, statusEl, target }
let activePaneSpeech = null;

function stopActivePaneSpeech() {
  if (activePaneSpeech) {
    try { activePaneSpeech.onresult = null; activePaneSpeech.onerror = null; activePaneSpeech.onend = null; } catch {}
    try { activePaneSpeech.stop(); } catch {}
    activePaneSpeech = null;
  }
}

function closeActivePaneInteract() {
  stopActivePaneSpeech();
  if (!activePaneInteract) return;
  try {
    activePaneInteract.overlay.classList.add("hidden");
    activePaneInteract.panel.classList.remove("pane-interact-active");
  } catch {}
  activePaneInteract = null;
}


function scrollActiveTabIntoView(tab, smooth = false) {
  if (!tabBarEl || !tab) return;
  tab.scrollIntoView({
    block: "nearest",
    inline: "center",
    behavior: smooth ? "smooth" : "auto",
  });
}

function sendScreensTabState(active) {
  screensTabActive = active;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: active ? "status_tab_active" : "status_tab_inactive" }));
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    const smoothScroll = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wasVoice = document.getElementById("voice-view").classList.contains("active");
    const wasScreens = document.getElementById("screens-view").classList.contains("active");
    const wasSummary = document.getElementById("summary-view").classList.contains("active");
    const wasCompleted = document.getElementById("completed-view").classList.contains("active");
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    scrollActiveTabIntoView(tab, smoothScroll);
    tabContents.forEach((c) => {
      c.classList.toggle("active", c.id === target + "-view");
    });
    // Notify server about screens tab activation/deactivation
    if (target === "screens" && !wasScreens) sendScreensTabState(true);
    if (target !== "screens" && wasScreens) { sendScreensTabState(false); closeActivePaneInteract(); }
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

    // Summary tab: auto-refresh once on tab switch so the user sees fresh data.
    if (target === "summary" && !wasSummary) refreshSummary();
    if (target === "completed" && !wasCompleted) refreshCompletedTasks();
  });
});

scrollActiveTabIntoView(document.querySelector("#tab-bar .tab.active"));

// --- Screens tab (live streaming) ---
const statusTimeEl = document.getElementById("status-time");
const statusPanesEl = document.getElementById("status-panes");

const panelMap = new Map();

function sendPaneText(target, text) {
  const trimmed = (text || "").trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: "pane_send_text", target, text: trimmed }));
  return true;
}

function sendPaneInterrupt(target) {
  if (!target || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: "pane_interrupt", target }));
  return true;
}

function ensurePaneOverlay(entry, label) {
  if (entry.overlay) return;

  entry.panel.classList.add("pane-interact-host");

  const overlay = document.createElement("div");
  overlay.className = "pane-interact-overlay hidden";

  const topRow = document.createElement("div");
  topRow.className = "pane-interact-top";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "pane-interact-input";
  input.placeholder = "Type a command...";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.enterKeyHint = "send";

  const send = document.createElement("button");
  send.className = "pane-interact-btn pane-interact-send";
  send.textContent = "Send";

  topRow.appendChild(input);
  topRow.appendChild(send);

  const btnRow = document.createElement("div");
  btnRow.className = "pane-interact-actions";

  const voice = document.createElement("button");
  voice.className = "pane-interact-btn pane-interact-voice";
  voice.textContent = "Voice";

  const interrupt = document.createElement("button");
  interrupt.className = "pane-interact-btn pane-interact-interrupt";
  interrupt.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg> Interrupt';

  const close = document.createElement("button");
  close.className = "pane-interact-btn pane-interact-close";
  close.textContent = "Close";

  btnRow.appendChild(voice);
  btnRow.appendChild(interrupt);
  btnRow.appendChild(close);

  const status = document.createElement("div");
  status.className = "pane-interact-status";
  status.textContent = label || "";

  overlay.appendChild(topRow);
  overlay.appendChild(btnRow);
  overlay.appendChild(status);
  entry.panel.appendChild(overlay);

  function doSend() {
    unlockAudio();
    const ok = sendPaneText(entry.target, input.value);
    if (ok) {
      playDing(true);
      input.value = "";
      input.focus();
    } else {
      playDing(false);
      status.textContent = "Disconnected";
    }
  }

  send.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSend();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeActivePaneInteract();
    }
  });

  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeActivePaneInteract();
  });

  interrupt.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    unlockAudio();
    const ok = sendPaneInterrupt(entry.target);
    playDing(ok);
  });

  voice.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      status.textContent = "Speech-to-text not supported in this browser";
      playDing(false);
      return;
    }

    // Toggle off if already listening.
    if (activePaneSpeech) {
      stopActivePaneSpeech();
      status.textContent = "Stopped";
      return;
    }

    unlockAudio();
    const rec = new SpeechRecognition();
    activePaneSpeech = rec;

    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;

    status.textContent = "Listening...";

    rec.onresult = (evt) => {
      let finalText = "";
      let interim = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        const text = (res[0] && res[0].transcript) ? res[0].transcript : "";
        if (res.isFinal) finalText += text;
        else interim += text;
      }

      const live = (finalText || interim).trim();
      if (live) input.value = live;

      if (finalText && finalText.trim()) {
        status.textContent = "Sending...";
        const ok = sendPaneText(entry.target, finalText);
        playDing(ok);
        input.value = "";
        input.focus();
      }
    };

    rec.onerror = (err) => {
      status.textContent = "Voice error: " + (err && err.error ? err.error : "unknown");
      playDing(false);
    };

    rec.onend = () => {
      if (activePaneSpeech === rec) activePaneSpeech = null;
      status.textContent = label || "";
    };

    try {
      rec.start();
    } catch {
      activePaneSpeech = null;
      status.textContent = "Voice start failed";
      playDing(false);
    }
  });

  entry.overlay = overlay;
  entry.input = input;
  entry.statusEl = status;
}

function openPaneInteract(entry, label) {
  closeActivePaneInteract();
  ensurePaneOverlay(entry, label);

  entry.panel.classList.add("pane-interact-active");
  entry.overlay.classList.remove("hidden");

  activePaneInteract = {
    key: entry.key,
    panel: entry.panel,
    overlay: entry.overlay,
    input: entry.input,
    statusEl: entry.statusEl,
    target: entry.target,
  };

  // Autofocus on open (mobile-friendly)
  setTimeout(() => {
    try {
      entry.input.focus();
    } catch {}
  }, 0);
}

document.addEventListener("pointerdown", (e) => {
  if (!document.getElementById("screens-view").classList.contains("active")) return;
  if (!activePaneInteract) return;
  const t = e.target;
  if (activePaneInteract.overlay && activePaneInteract.overlay.contains(t)) return;
  if (activePaneInteract.panel && activePaneInteract.panel.contains(t)) return;
  closeActivePaneInteract();
});

function renderStreamUpdate(data) {
  if (!data.sessions || data.sessions.length === 0) {
    statusTimeEl.textContent = "no sessions";
    statusTimeEl.className = "";
    for (const [, entry] of panelMap) entry.panel.remove();
    panelMap.clear();
    closeActivePaneInteract();
    if (!statusPanesEl.querySelector(".status-empty")) {
      statusPanesEl.innerHTML = '<div class="status-empty">No tmux sessions found</div>';
    }
    return;
  }

  statusTimeEl.textContent = "● LIVE";
  statusTimeEl.className = "live-indicator";

  const emptyMsg = statusPanesEl.querySelector(".status-empty");
  if (emptyMsg) emptyMsg.remove();

  const currentKeys = new Set();

  for (const session of data.sessions) {
    for (const win of (session.windows || [])) {
      const panes = Array.isArray(win.panes) && win.panes.length
        ? win.panes
        : [{ index: 0, target: `${session.name}:0.0`, content: win.content || "" }];

      for (const pane of panes) {
        const key = `${session.name}	${win.name}	${pane.target || pane.id || pane.index}`;
        currentKeys.add(key);

        let entry = panelMap.get(key);
        if (!entry) {
          const panel = document.createElement("div");
          panel.className = "stream-panel collapsed";

          const header = document.createElement("div");
          header.className = "stream-panel-header";
          header.textContent = `${session.name} / ${win.name} · pane ${pane.index}`;
          header.title = pane.target || "";
          header.addEventListener("click", () => {
            panel.classList.toggle("collapsed");
          });
          panel.appendChild(header);

          const pre = document.createElement("pre");
          pre.className = "stream-panel-content";
          pre.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const current = panelMap.get(key);
            if (current) {
              openPaneInteract(current, `${session.name} / ${win.name} · ${current.target || ""}`);
            }
          });
          panel.appendChild(pre);

          statusPanesEl.appendChild(panel);
          entry = {
            key,
            panel,
            pre,
            target: pane.target,
            lastContent: "",
            overlay: null,
            input: null,
            statusEl: null,
          };
          panelMap.set(key, entry);
        } else {
          entry.target = pane.target;
        }

        const content = pane.content || "";
        if (content !== entry.lastContent) {
          const wasAtBottom =
            entry.pre.scrollHeight - entry.pre.scrollTop - entry.pre.clientHeight < 40;
          entry.pre.textContent = content;
          entry.lastContent = content;
          if (wasAtBottom) {
            entry.pre.scrollTop = entry.pre.scrollHeight;
          }
        }
      }
    }
  }

  for (const [key, entry] of panelMap) {
    if (!currentKeys.has(key)) {
      if (activePaneInteract && activePaneInteract.key === key) closeActivePaneInteract();
      entry.panel.remove();
      panelMap.delete(key);
    }
  }
}
// --- Summary tab ---
const summaryTabContentEl = document.getElementById("summary-tab-content");
const refreshSummaryBtn = document.getElementById("refresh-summary-btn");

async function refreshSummary() {
  // Prevent overlapping fetches (auto-refresh on tab switch + manual clicks).
  if (refreshSummaryBtn.disabled) return;

  refreshSummaryBtn.disabled = true;
  refreshSummaryBtn.textContent = "Loading...";
  summaryTabContentEl.innerHTML = '<div class="summary-loading">Generating summary...</div>';

  try {
    const resp = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Request failed" }));
      summaryTabContentEl.innerHTML = '<div class="summary-error">Error: ' +
        (err.error || "Request failed").replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</div>';
      return;
    }
    const data = await resp.json();
    summaryTabContentEl.innerHTML = mdToHtml(data.summary);
  } catch (err) {
    summaryTabContentEl.innerHTML = '<div class="summary-error">Error: ' +
      err.message.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</div>';
  } finally {
    refreshSummaryBtn.disabled = false;
    refreshSummaryBtn.textContent = "Refresh";
  }
}

function mdToHtml(md) {
  if (!md) return "";
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inUl = false;
  let inCode = false;
  let codeLines = [];

  function closeUl() {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  }

  function closeCode() {
    if (inCode) {
      out.push(`<pre class="md-code"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      inCode = false;
      codeLines = [];
    }
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeUl();
      if (inCode) {
        closeCode();
      } else {
        inCode = true;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      closeUl();
      const tag = "h" + Math.min(headerMatch[1].length + 1, 4);
      out.push(`<${tag}>${inlineMd(headerMatch[2])}</${tag}>`);
      continue;
    }
    const liMatch = line.match(/^[-*]\s+(.+)$/);
    if (liMatch) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineMd(liMatch[1])}</li>`);
      continue;
    }
    closeUl();
    if (line.trim() === "") {
      out.push("<br>");
    } else {
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeUl();
  closeCode();
  return out.join("");
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatCompletedAt(iso) {
  const dt = new Date(iso || "");
  if (!Number.isFinite(dt.valueOf())) return "unknown time";
  return dt.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderCompletedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    completedTabContentEl.innerHTML = '<div class="completed-empty">No completed tasks yet.</div>';
    return;
  }

  const list = document.createElement("div");
  list.className = "completed-task-list";

  for (const task of tasks) {
    const item = document.createElement("details");
    item.className = "completed-task-item";

    const summary = document.createElement("summary");
    summary.className = "completed-task-summary";

    const heading = document.createElement("div");
    heading.className = "completed-task-heading";
    heading.textContent = `${task.task_name || "unnamed-task"} · ${formatCompletedAt(task.completed_at)}`;

    const shortSummary = document.createElement("div");
    shortSummary.className = "completed-task-short";
    shortSummary.textContent = task.short_summary || "(No short summary)";

    summary.appendChild(heading);
    summary.appendChild(shortSummary);
    item.appendChild(summary);

    const body = document.createElement("div");
    body.className = "completed-task-body";

    const meta = document.createElement("div");
    meta.className = "completed-task-meta";
    const workerType = task.worker_type || "unknown";
    const session = task.session || "unknown";
    const windowName = task.window || "unknown";
    meta.textContent = `Worker: ${workerType} · Session: ${session} · Window: ${windowName}`;
    body.appendChild(meta);

    if (task.detailed_summary) {
      const detailed = document.createElement("div");
      detailed.className = "completed-task-detailed";
      detailed.innerHTML = mdToHtml(task.detailed_summary);
      body.appendChild(detailed);
    }

    if (task.task_definition) {
      const defDetails = document.createElement("details");
      defDetails.className = "task-definition-details";
      const defSummary = document.createElement("summary");
      defSummary.textContent = "Task definition";
      const defBody = document.createElement("div");
      defBody.className = "task-definition-body";
      defBody.innerHTML = mdToHtml(task.task_definition);
      defDetails.appendChild(defSummary);
      defDetails.appendChild(defBody);
      body.appendChild(defDetails);
    }

    item.appendChild(body);
    list.appendChild(item);
  }

  completedTabContentEl.innerHTML = "";
  completedTabContentEl.appendChild(list);
}

async function refreshCompletedTasks() {
  if (refreshCompletedBtn.disabled) return;

  refreshCompletedBtn.disabled = true;
  refreshCompletedBtn.textContent = "Loading...";
  completedTabContentEl.innerHTML = '<div class="completed-loading">Loading completed tasks...</div>';

  try {
    const resp = await fetch(`/api/completed-tasks?token=${encodeURIComponent(token)}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Request failed" }));
      completedTabContentEl.innerHTML = '<div class="completed-error">Error: ' +
        escapeHtml(err.error || "Request failed") + "</div>";
      return;
    }
    const data = await resp.json();
    renderCompletedTasks(data.tasks || []);
  } catch (err) {
    completedTabContentEl.innerHTML = '<div class="completed-error">Error: ' +
      escapeHtml(err.message || "Request failed") + "</div>";
  } finally {
    refreshCompletedBtn.disabled = false;
    refreshCompletedBtn.textContent = "Refresh";
  }
}

refreshSummaryBtn.addEventListener("click", refreshSummary);
refreshCompletedBtn.addEventListener("click", refreshCompletedTasks);

setInterval(() => {
  if (document.getElementById("completed-view").classList.contains("active")) {
    refreshCompletedTasks();
  }
}, 30000);

renderMessageHistorySelect();
renderSpeakHistorySelect();
connect();
