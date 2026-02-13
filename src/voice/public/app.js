const terminalEl = document.getElementById("terminal");
const summaryEl = document.getElementById("summary");
const transcriptionEl = document.getElementById("transcription");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const textInput = document.getElementById("text-input");
const textPopoutBtn = document.getElementById("text-popout-btn");
const sendBtn = document.getElementById("send-btn");
const textPopoutModal = document.getElementById("text-popout-modal");
const textPopoutBackdrop = document.getElementById("text-popout-backdrop");
const textPopoutTextarea = document.getElementById("text-popout-textarea");
const textPopoutSendBtn = document.getElementById("text-popout-send-btn");
const textPopoutCloseBtn = document.getElementById("text-popout-close-btn");
const textPopoutCancelBtn = document.getElementById("text-popout-cancel-btn");
const voiceHistoryModal = document.getElementById("voice-history-modal");
const voiceHistoryBackdrop = document.getElementById("voice-history-backdrop");
const voiceHistoryCloseBtn = document.getElementById("voice-history-close-btn");
const voiceHistoryList = document.getElementById("voice-history-list");
const voiceHistoryModalBtn = document.getElementById("voice-history-modal-btn");
const updateBtn = document.getElementById("update-btn");
const autoreadCb = document.getElementById("autoread-cb");
const voiceAutoreadCb = document.getElementById("voice-autoread-cb");
const autolistenCb = document.getElementById("autolisten-cb");
const voiceAutolistenCb = document.getElementById("voice-autolisten-cb");
const voiceMicBtn = document.getElementById("voice-mic-btn");
const voiceReplayBtn = document.getElementById("voice-replay-btn");
const voiceStatusBtn = document.getElementById("voice-status-btn");
const voiceSummaryEl = document.getElementById("voice-summary");
const voiceTranscriptionEl = document.getElementById("voice-transcription");
const voiceInterruptBtn = document.getElementById("voice-interrupt-btn");
const voiceHistorySelect = document.getElementById("voice-history-select");
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
let ttsFormat = "opus";
let ttsMime = "audio/ogg";

// ── TTS Playback Queue (FIFO) ────────────────────────────────────────────────
// Declared early because Auto-read is initialized before the Audio element is created,
// and disabling auto-read calls stopTtsPlayback() during initial script evaluation.
const TTS_PLAYBACK_QUEUE_LIMIT = 50;
let ttsPlaybackQueue = []; // [{ id, data:ArrayBuffer, enqueuedAt:number }]
let ttsPlaybackNextId = 1;
let ttsPlaybackPlaying = false;
let ttsPlaybackDrainScheduled = false;
let ttsPlaybackCurrentUrl = null;
let ttsPlaybackPlayBlockedAt = 0; // throttle logs if autoplay is blocked

// Core runtime state (declared early so localStorage-driven toggles can safely run on load).
let ws = null;
let mediaRecorder = null;
let recording = false;
let wantRecording = false; // true while user is holding the mic button
let recordingStartTime = 0;
let micStream = null;
let micStreamAcquired = false;
let autoScroll = true;
let disconnectedFlashTimer = null;
let maxRecordingTimer = null;
let activePaneSpeech = null; // Web Speech API recognition (uses mic)

let recordingSessionId = 0; // increments per recording; used to abort onstop side effects
let abortRecordingUpload = false;

let audioCtx = null; // declared early; initialized lazily by getAudioContext()

function isMicStreamLive() {
  try {
    return !!(micStream && micStream.getTracks && micStream.getTracks().some((t) => t && t.readyState === "live"));
  } catch {
    return false;
  }
}

function computeMicCaptureState() {
  // "Capture" means the browser is actively holding the microphone.
  // This is intentionally independent of the Auto Listen preference toggle.
  const streamLive = isMicStreamLive();
  const recorderLive = !!(mediaRecorder && mediaRecorder.state && mediaRecorder.state !== "inactive");
  const speechLive = !!activePaneSpeech;
  const active = streamLive || recorderLive || speechLive || recording || wantRecording;
  let source = "";
  if (recorderLive || recording || wantRecording) source = "recording";
  else if (speechLive) source = "speech";
  else if (streamLive) source = "stream";
  return { active, source };
}

function renderMicCaptureState() {
  const { active, source } = computeMicCaptureState();
  try {
    document.documentElement.dataset.micActive = active ? "true" : "false";
    document.documentElement.dataset.micSource = source || "";
  } catch {}
}

function mimeForTtsFormat(fmt) {
  switch (String(fmt || "").toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "aac":
      return "audio/aac";
    case "opus":
    default:
      return "audio/ogg";
  }
}

function selectBestTtsFormat() {
  // Prefer Opus when the browser can actually decode it; fall back to MP3/AAC.
  // This avoids iPadOS "desktop UA" cases where user-agent sniffing fails.
  const a = new Audio();
  const can = (mime) => {
    if (!a.canPlayType) return "";
    try {
      return a.canPlayType(mime) || "";
    } catch {
      return "";
    }
  };

  // Opus in an Ogg container (what we send for response_format=opus).
  if (can('audio/ogg; codecs="opus"')) return "opus";
  if (can("audio/ogg")) return "opus";

  if (can("audio/mpeg")) return "mp3";

  // iOS Safari sometimes prefers MP4/AAC; OpenAI supports response_format=aac.
  if (can('audio/mp4; codecs="mp4a.40.2"')) return "aac";
  if (can("audio/aac")) return "aac";

  return "opus";
}

function setLatestVoiceSummary(text) {
  const t = typeof text === "string" ? text : "";
  if (summaryEl) summaryEl.textContent = t;
  if (voiceSummaryEl) voiceSummaryEl.textContent = t;
}

// Auto-read toggle: OFF by default, persisted in localStorage
function setAutoReadEnabled(enabled, { persist = true } = {}) {
  const val = !!enabled;
  if (autoreadCb) autoreadCb.checked = val;
  if (voiceAutoreadCb) voiceAutoreadCb.checked = val;
  if (persist) localStorage.setItem("autoread", String(val));
  if (!val) {
    stopTtsPlayback();
    speakAudioQueue = [];
  }
}

setAutoReadEnabled(localStorage.getItem("autoread") === "true", { persist: false });
[autoreadCb, voiceAutoreadCb].forEach((cb) => {
  if (!cb) return;
  cb.addEventListener("change", () => setAutoReadEnabled(cb.checked));
});

// Auto Listen toggle: ON by default (keep mic stream acquired in background)
let autoListenEnabled = true;
let micStreamAcquireSeq = 0; // increments to invalidate in-flight getUserMedia() calls
function setAutoListenUi(enabled) {
  const val = !!enabled;
  if (autolistenCb) autolistenCb.checked = val;
  if (voiceAutolistenCb) voiceAutolistenCb.checked = val;
}

function closeAudioContext() {
  if (!audioCtx) return;
  try {
    if (typeof audioCtx.close === "function") {
      audioCtx.close().catch(() => {});
    }
  } catch {}
  audioCtx = null;
}

function stopMicStream() {
  try {
    if (micStream) {
      micStream.getTracks().forEach((t) => {
        try { t.stop(); } catch {}
      });
    }
  } finally {
    micStream = null;
    renderMicCaptureState();
  }
}

function abortActiveRecording() {
  wantRecording = false;
  recording = false;
  abortRecordingUpload = true;
  // Invalidate any in-flight onstop upload loop even if it already passed its first guard.
  recordingSessionId++;

  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  micBtn.classList.remove("recording");
  voiceMicBtn.classList.remove("recording");
  speakAudioQueue = [];

  if (mediaRecorder) {
    // Prevent upload side effects when stopping due to Auto Listen OFF.
    try { mediaRecorder.ondataavailable = null; } catch {}
    try { mediaRecorder.onstop = null; } catch {}
    try {
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch {}
  }
  mediaRecorder = null;
  renderMicCaptureState();
}

function maybeSendAudioCancel(reason) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Only send cancel when we might have an in-flight upload/recording/session on this socket.
    const shouldCancel = !!(mediaRecorder || recording || wantRecording || isMicStreamLive());
    if (!shouldCancel) return;
    ws.send(JSON.stringify({ type: "audio_cancel", reason: reason || "" }));
  } catch {}
}

async function setAutoListenEnabled(enabled, { persist = true, acquire = false } = {}) {
  autoListenEnabled = !!enabled;
  setAutoListenUi(autoListenEnabled);
  if (persist) localStorage.setItem("autolisten", String(autoListenEnabled));

  if (!autoListenEnabled) {
    // Invalidate any in-flight `getUserMedia()` so it can't re-acquire after OFF.
    micStreamAcquireSeq++;
    // If the user disables listening while holding the mic, stop immediately.
    if (recording || wantRecording || mediaRecorder) abortActiveRecording();
    maybeSendAudioCancel("autolisten_off");

    // Web Speech recognition also uses the microphone (iOS Safari shows the mic indicator).
    stopActivePaneSpeech();

    stopMicStream();
    micStreamAcquired = false;
    closeAudioContext();
    renderMicCaptureState();
    return;
  }

  if (acquire) {
    try {
      await ensureMicStream();
      micStreamAcquired = !!(micStream && micStream.getTracks().some((t) => t.readyState === "live"));
    } catch {}
    renderMicCaptureState();
  }
}

const storedAutoListen = localStorage.getItem("autolisten");
setAutoListenEnabled(storedAutoListen === null ? true : storedAutoListen === "true", { persist: false });
[autolistenCb, voiceAutolistenCb].forEach((cb) => {
  if (!cb) return;
  cb.addEventListener("change", () => setAutoListenEnabled(cb.checked, { acquire: true }));
});
renderMicCaptureState();
// Poll occasionally so UI reflects "true" mic capture state even if a track ends without events.
setInterval(() => {
  try { renderMicCaptureState(); } catch {}
}, 750);

const MIN_RECORDING_MS = 300;
const MIN_AUDIO_BYTES = 1000;
const MEDIARECORDER_TIMESLICE_MS = 250;
const MAX_RECORDING_MS = 15 * 60 * 1000; // 15 minutes
const WS_AUDIO_FRAME_BYTES = 64 * 1024;

// Persistent audio element — unlocked on first user gesture so TTS can play later
const ttsAudio = new Audio();
ttsAudio.setAttribute("playsinline", "");
ttsAudio.setAttribute("webkit-playsinline", "");
let audioUnlocked = false;

// Tiny silent WAV data URI used only to prime iOS Safari audio on first user gesture.
// This is intentionally static (no keepalive loops / media session / hardware control bridging).
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQIAAAAAAA==";

function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioCtx) {
    audioCtx = new AudioContextCtor();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function playChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
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
    if (!ctx) return;
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
  const primer = new Audio();
  primer.src = SILENT_WAV_DATA_URI;
  primer.setAttribute("playsinline", "");
  primer.setAttribute("webkit-playsinline", "");
  primer.play().then(() => {
    audioUnlocked = true;
    try {
      primer.pause();
      primer.currentTime = 0;
    } catch {}
    // If any TTS was queued while autoplay was locked, try draining now.
    drainTtsPlaybackQueueSoon();
  }).catch((err) => {
    // Best-effort only: user can still tap replay, and subsequent gestures may unlock.
    console.warn("Audio unlock primer blocked:", err && err.message ? err.message : "unknown");
  });
  getAudioContext(); // warm up AudioContext during user gesture
}

function stopTtsPlayback() {
  try {
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
  } catch {}
  ttsPlaybackPlaying = false;
  ttsPlaybackQueue = [];
  ttsPlaybackDrainScheduled = false;
  if (ttsPlaybackCurrentUrl) {
    try { URL.revokeObjectURL(ttsPlaybackCurrentUrl); } catch {}
  }
  ttsPlaybackCurrentUrl = null;
}

function onTtsPlaybackFinished(reason) {
  // Release current blob URL to avoid leaking.
  if (ttsPlaybackCurrentUrl) {
    try { URL.revokeObjectURL(ttsPlaybackCurrentUrl); } catch {}
  }
  ttsPlaybackCurrentUrl = null;
  ttsPlaybackPlaying = false;
  drainTtsPlaybackQueueSoon();
}

ttsAudio.addEventListener("ended", () => onTtsPlaybackFinished("ended"));
ttsAudio.addEventListener("error", () => onTtsPlaybackFinished("error"));

function enqueueTtsPlayback(data, { reason = "tts" } = {}) {
  if (!data) return;
  ttsPlaybackQueue.push({
    id: ttsPlaybackNextId++,
    data,
    enqueuedAt: Date.now(),
    reason,
  });

  // Cap total pending clips (current + queued) to avoid unbounded growth.
  // If a clip is already playing, allow at most (limit - 1) queued items.
  const maxQueued = ttsPlaybackPlaying
    ? Math.max(0, TTS_PLAYBACK_QUEUE_LIMIT - 1)
    : TTS_PLAYBACK_QUEUE_LIMIT;
  if (ttsPlaybackQueue.length > maxQueued) {
    const drop = ttsPlaybackQueue.length - maxQueued;
    ttsPlaybackQueue.splice(0, drop);
    console.warn(`TTS playback queue exceeded ${TTS_PLAYBACK_QUEUE_LIMIT}; dropped ${drop} oldest clip(s).`);
  }

  drainTtsPlaybackQueueSoon();
}

function drainTtsPlaybackQueueSoon() {
  if (ttsPlaybackDrainScheduled) return;
  ttsPlaybackDrainScheduled = true;
  const schedule = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (fn) => Promise.resolve().then(fn);
  schedule(() => {
    ttsPlaybackDrainScheduled = false;
    drainTtsPlaybackQueue();
  });
}

function drainTtsPlaybackQueue() {
  // Auto-read OFF: do not autoplay queued clips (except explicit replay which calls playAudio()).
  // If autoread is toggled off mid-queue, stopTtsPlayback() clears it.
  if (ttsPlaybackPlaying) return;
  if (ttsPlaybackQueue.length === 0) return;

  const next = ttsPlaybackQueue.shift();
  if (!next || !next.data) return;

  // Start playback for this clip.
  const blob = new Blob([next.data], { type: ttsMime || "audio/ogg" });
  const url = URL.createObjectURL(blob);

  // Revoke previous URL only after we've already switched away from it.
  if (ttsPlaybackCurrentUrl) {
    try { URL.revokeObjectURL(ttsPlaybackCurrentUrl); } catch {}
  }
  ttsPlaybackCurrentUrl = url;

  ttsAudio.src = url;
  ttsPlaybackPlaying = true;

  // Resume AudioContext if suspended (mobile browsers suspend on background)
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

  ttsAudio.play().catch((err) => {
    // Autoplay can be blocked until a user gesture. Keep the clip at the head of the queue.
    ttsPlaybackPlaying = false;
    ttsPlaybackQueue.unshift(next);

    const now = Date.now();
    if (now - ttsPlaybackPlayBlockedAt > 2000) {
      ttsPlaybackPlayBlockedAt = now;
      console.warn("TTS play blocked:", err && err.message ? err.message : "unknown");
    }
  });
}

// Best-effort: when returning to a visible tab, resume a paused clip or continue draining the queue.
// Some browsers will pause media in background without firing 'ended', which could otherwise stall the queue.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (ttsPlaybackPlaying && ttsAudio && ttsAudio.paused && ttsAudio.src) {
    ttsAudio.play().catch(() => {
      // If it still can't play, the queue head remains intact (see play() catch path).
      drainTtsPlaybackQueueSoon();
    });
    return;
  }
  drainTtsPlaybackQueueSoon();
});

function handleIncomingTtsAudio(data, opts = {}) {
  lastTtsAudioData = data;
  voiceReplayBtn.disabled = false;
  const autoplay = opts.autoplay !== false;
  if (!autoplay) return;
  // Respect the auto-read toggle for autoplay; replay is always available.
  const shouldPlay = autoreadCb.checked;
  if (shouldPlay) {
    if (recording || wantRecording) {
      // Mic is active — hold audio until recording stops
      speakAudioQueue.push(data);
    } else {
      playAudio(data);
    }
  }
}

function playAudio(data) {
  enqueueTtsPlayback(data, { reason: "playAudio" });
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
const MESSAGE_HISTORY_LIMIT = 20;
const HISTORY_PREVIEW_MAX = 40;
let messageHistory = [];
let voiceSummaryHistory = [];

function normalizeVoiceHistoryEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      text: typeof item.text === "string" ? item.text.trim() : "",
      timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString(),
    }))
    .filter((item) => item.text);
}

function mergeVoiceHistoryEntries(existing, incoming) {
  const out = [];
  const seen = new Set();
  const add = (e) => {
    const key = `${e.timestamp}\n${e.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of normalizeVoiceHistoryEntries(existing)) add(e);
  for (const e of normalizeVoiceHistoryEntries(incoming)) add(e);

  // Keep newest-first for display.
  out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return out;
}

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

function isVoiceHistoryModalOpen() {
  return voiceHistoryModal && !voiceHistoryModal.classList.contains("hidden");
}

function closeVoiceHistoryModal() {
  if (!voiceHistoryModal) return;
  voiceHistoryModal.classList.add("hidden");
  voiceHistoryModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("voice-history-open");
}

function formatVoiceHistoryTimestamp(isoLike) {
  const dt = new Date(isoLike || "");
  if (!Number.isFinite(dt.valueOf())) return "Unknown time";
  return dt.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function handleVoiceHistoryEntryClick(text) {
  const ok = await replayHistoricalSpeak(text);
  playDing(ok);
}

function renderVoiceHistoryModal() {
  if (!voiceHistoryList) return;
  voiceHistoryList.innerHTML = "";

  if (!voiceSummaryHistory.length) {
    const empty = document.createElement("div");
    empty.className = "voice-history-empty";
    empty.textContent = "No voice summaries yet.";
    voiceHistoryList.appendChild(empty);
    return;
  }

  for (const entry of voiceSummaryHistory) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "voice-history-entry";
    item.dataset.summaryText = entry.text;

    const ts = document.createElement("div");
    ts.className = "voice-history-entry-time";
    ts.textContent = formatVoiceHistoryTimestamp(entry.timestamp);

    const txt = document.createElement("div");
    txt.className = "voice-history-entry-text";
    txt.textContent = entry.text;

    item.appendChild(ts);
    item.appendChild(txt);
    item.addEventListener("click", () => {
      handleVoiceHistoryEntryClick(entry.text);
    });
    voiceHistoryList.appendChild(item);
  }
}

function openVoiceHistoryModal() {
  if (!voiceHistoryModal) return;
  renderVoiceHistoryModal();
  voiceHistoryModal.classList.remove("hidden");
  voiceHistoryModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("voice-history-open");
}

function setVoiceSummaryHistory(entries) {
  // Merge rather than overwrite: speak_text can arrive before initial history fetch resolves.
  voiceSummaryHistory = mergeVoiceHistoryEntries(voiceSummaryHistory, entries);
  if (voiceSummaryHistory[0] && voiceSummaryHistory[0].text) {
    setLatestVoiceSummary(voiceSummaryHistory[0].text);
  }
  renderVoiceHistoryModal();
}

function prependVoiceSummaryEntry(entry) {
  if (!entry || typeof entry !== "object") return;
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (!text) return;
  voiceSummaryHistory.unshift({
    text,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
  });
  renderVoiceHistoryModal();
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

async function replayHistoricalSpeak(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  try {
    const resp = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text: trimmed, playbackOnly: true, format: ttsFormat }),
    });
    if (!resp.ok) return false;
    const audio = await resp.arrayBuffer();
    if (!audio || audio.byteLength === 0) return false;
    handleIncomingTtsAudio(audio, { autoplay: false });
    // Explicit replay should play regardless of auto-read toggle.
    playAudio(audio);
    return true;
  } catch {
    return false;
  }
}

loadMessageHistory();

async function loadVoiceSummaryHistory() {
  try {
    const resp = await fetch(`/api/voice-history?token=${encodeURIComponent(token)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    setVoiceSummaryHistory(data.entries || []);
  } catch {}
}

terminalEl.addEventListener("scroll", () => {
  const { scrollTop, scrollHeight, clientHeight } = terminalEl;
  autoScroll = scrollHeight - scrollTop - clientHeight < 40;
});

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const desiredTts = selectBestTtsFormat();
  // Best-effort: set defaults before the server sends tts_config.
  ttsFormat = desiredTts;
  ttsMime = mimeForTtsFormat(desiredTts);
  // Explicitly use window.WebSocket so Playwright tests can stub it reliably.
  const WebSocketCtor = window.WebSocket || WebSocket;
  ws = new WebSocketCtor(
    `${proto}//${location.host}?token=${encodeURIComponent(token)}&tts=${encodeURIComponent(desiredTts)}`
  );
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    statusEl.textContent = "connecting...";
    statusEl.className = "disconnected";
    // Re-send screens tab state on reconnect
    if (screensTabActive) {
      ws.send(JSON.stringify({ type: "status_tab_active" }));
    }
  };

  ws.onmessage = async (evt) => {
    // Any binary frame from server = TTS audio, store for replay and maybe autoplay.
    if (evt.data instanceof ArrayBuffer) {
      handleIncomingTtsAudio(evt.data);
      return;
    }
    if (evt.data instanceof Blob) {
      const buf = await evt.data.arrayBuffer().catch(() => null);
      if (!buf) return;
      handleIncomingTtsAudio(buf);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

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

      case "tts_config":
        if (msg && typeof msg.format === "string") ttsFormat = msg.format;
        if (msg && typeof msg.mime === "string") ttsMime = msg.mime;
        break;

      case "tmux_snapshot":
        pendingSnapshot = msg.content;
        break;

      case "speak_text":
        if (msg.text) {
          setLatestVoiceSummary(msg.text);
          prependVoiceSummaryEntry({
            text: msg.text,
            timestamp: msg.timestamp,
          });
        }
        break;
      case "voice_history":
        setVoiceSummaryHistory(msg.entries || []);
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
  if (!autoListenEnabled) {
    throw new Error("Auto Listen is off");
  }
  if (isMicStreamLive()) return true;
  const seq = ++micStreamAcquireSeq;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // If Auto Listen was turned off (or another acquire superseded this one) while we were waiting,
  // immediately stop tracks so iPadOS releases the mic and the indicator turns off.
  if (!autoListenEnabled || seq !== micStreamAcquireSeq) {
    try { stream.getTracks().forEach((t) => { try { t.stop(); } catch {} }); } catch {}
    renderMicCaptureState();
    return false;
  }
  micStream = stream;
  try {
    stream.getTracks().forEach((t) => {
      try { t.onended = () => renderMicCaptureState(); } catch {}
    });
  } catch {}
  renderMicCaptureState();
  return true;
}

// Text command
function sendText() {
  unlockAudio();
  const text = textInput.value.trim();
  if (!text) return;
  if (!sendTextCommand(text)) return;
  textInput.value = "";
}

function isTextPopoutOpen() {
  return textPopoutModal && !textPopoutModal.classList.contains("hidden");
}

function closeTextPopout({ sent = false } = {}) {
  if (!textPopoutModal || !textPopoutTextarea) return;
  if (!sent) {
    textInput.value = textPopoutTextarea.value;
  } else {
    textInput.value = "";
  }
  textPopoutModal.classList.add("hidden");
  textPopoutModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("text-popout-open");
}

function openTextPopout() {
  if (!textPopoutModal || !textPopoutTextarea) return;
  textPopoutTextarea.value = textInput.value;
  textPopoutModal.classList.remove("hidden");
  textPopoutModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("text-popout-open");
  setTimeout(() => {
    textPopoutTextarea.focus();
    textPopoutTextarea.selectionStart = textPopoutTextarea.value.length;
    textPopoutTextarea.selectionEnd = textPopoutTextarea.value.length;
  }, 0);
}

function sendTextFromPopout() {
  if (!textPopoutTextarea) return;
  unlockAudio();
  const text = textPopoutTextarea.value.trim();
  if (!text) return;
  if (!sendTextCommand(text)) return;
  closeTextPopout({ sent: true });
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
if (textPopoutBtn) {
  textPopoutBtn.addEventListener("click", openTextPopout);
}
if (textPopoutSendBtn) {
  textPopoutSendBtn.addEventListener("click", sendTextFromPopout);
}
if (textPopoutCloseBtn) {
  textPopoutCloseBtn.addEventListener("click", () => closeTextPopout());
}
if (textPopoutCancelBtn) {
  textPopoutCancelBtn.addEventListener("click", () => closeTextPopout());
}
if (textPopoutBackdrop) {
  textPopoutBackdrop.addEventListener("click", () => closeTextPopout());
}
if (textPopoutTextarea) {
  textPopoutTextarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendTextFromPopout();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeTextPopout();
    }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isTextPopoutOpen()) {
    e.preventDefault();
    closeTextPopout();
    return;
  }
  if (e.key === "Escape" && isVoiceHistoryModalOpen()) {
    e.preventDefault();
    closeVoiceHistoryModal();
  }
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

if (voiceHistoryModalBtn) {
  voiceHistoryModalBtn.addEventListener("click", openVoiceHistoryModal);
}
if (summaryEl) {
  summaryEl.addEventListener("click", openVoiceHistoryModal);
}
if (voiceSummaryEl) {
  voiceSummaryEl.addEventListener("click", openVoiceHistoryModal);
}
if (voiceHistoryCloseBtn) {
  voiceHistoryCloseBtn.addEventListener("click", closeVoiceHistoryModal);
}
if (voiceHistoryBackdrop) {
  voiceHistoryBackdrop.addEventListener("click", closeVoiceHistoryModal);
}

// Mic recording — uses pre-acquired stream for instant start
function startRecording() {
  unlockAudio();
  if (!autoListenEnabled) {
    wantRecording = false;
    transcriptionEl.textContent = "Mic is off (Auto Listen disabled)";
    transcriptionEl.className = "error";
    voiceTranscriptionEl.textContent = "Mic off";
    voiceTranscriptionEl.className = "voice-transcription error";
    playDing(false);
    renderMicCaptureState();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    wantRecording = false;
    playDing(false);
    flashDisconnectedIndicator();
    renderMicCaptureState();
    return;
  }

  if (!micStream || !micStream.getTracks().some((t) => t.readyState === "live")) {
    // Stream missing or dead — (re)acquire, then start only if user is still holding
    micStream = null;
    ensureMicStream().then((ok) => {
      if (!autoListenEnabled) return;
      if (!ok) return;
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
  const mySessionId = ++recordingSessionId;
  abortRecordingUpload = false;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (abortRecordingUpload || !autoListenEnabled || mySessionId !== recordingSessionId) {
      return;
    }
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
    // Guard again before sending anything (Auto Listen may have been toggled OFF after the first check).
    if (abortRecordingUpload || !autoListenEnabled || mySessionId !== recordingSessionId) {
      maybeSendAudioCancel("client_abort_before_upload");
      return;
    }
    ws.send(JSON.stringify({ type: "audio_start", mimeType }));

    // This is "upload" over WebSocket. There's no true per-byte upload progress API for
    // WebSockets, but we *can* track `ws.bufferedAmount` draining, which reflects how many
    // bytes are still queued to be sent from the browser to the server.
    let totalBytes = 0;
    for (const chunk of recordedChunks) totalBytes += chunk.size;
    if (totalBytes <= 0) totalBytes = 1;

    let lastPct = -1;
    let lastUiUpdate = 0;
    const maybeUpdatePct = (pct, force = false) => {
      const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
      const now = Date.now();
      if (!force) {
        // Throttle DOM updates to keep UI responsive.
        if (safePct === lastPct) return;
        if (now - lastUiUpdate < 60 && safePct < 100) return;
      }
      lastPct = safePct;
      lastUiUpdate = now;
      showUploadingIndicator(safePct);
    };

    const baseBufferedAmount = ws.bufferedAmount;
    let queuedBytes = 0;
    let doneQueueing = false;
    const DRAIN_EPSILON_BYTES = 16 * 1024; // allow for small control frames and measurement jitter
    const DRAIN_TIMEOUT_MS = 120 * 1000;

    const computePctFromBufferedAmount = () => {
      const bufferedDelta = Math.max(0, ws.bufferedAmount - baseBufferedAmount);
      const uploadedBytes = Math.max(0, queuedBytes - bufferedDelta);
      // Hold at 99% until the socket buffer has actually drained.
      if (!doneQueueing) {
        return Math.min(99, (uploadedBytes / totalBytes) * 100);
      }
      if (bufferedDelta > DRAIN_EPSILON_BYTES) {
        return Math.min(99, (uploadedBytes / totalBytes) * 100);
      }
      return 100;
    };

    let monitorTimer = null;
    try {
      // Periodically update UI from `bufferedAmount` drain (actual bytes leaving the browser).
      monitorTimer = setInterval(() => {
        maybeUpdatePct(computePctFromBufferedAmount(), false);
      }, 50);
      maybeUpdatePct(0, true);

      for (const chunk of recordedChunks) {
        if (abortRecordingUpload || !autoListenEnabled || mySessionId !== recordingSessionId) {
          maybeSendAudioCancel("client_abort_mid_upload");
          return;
        }
        const chunkBytes = new Uint8Array(await chunk.arrayBuffer());
        for (let offset = 0; offset < chunkBytes.byteLength; offset += WS_AUDIO_FRAME_BYTES) {
          if (abortRecordingUpload || !autoListenEnabled || mySessionId !== recordingSessionId) {
            maybeSendAudioCancel("client_abort_mid_upload");
            return;
          }
          const frame = chunkBytes.slice(offset, offset + WS_AUDIO_FRAME_BYTES);
          ws.send(frame);
          queuedBytes += frame.byteLength;
        }
      }
      doneQueueing = true;
      ws.send(JSON.stringify({ type: "audio_end" }));

      // Wait until the WS send buffer drains so 100% reflects real upload completion.
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (abortRecordingUpload || !autoListenEnabled || mySessionId !== recordingSessionId) {
          maybeSendAudioCancel("client_abort_during_drain");
          return;
        }
        const bufferedDelta = Math.max(0, ws.bufferedAmount - baseBufferedAmount);
        if (bufferedDelta <= DRAIN_EPSILON_BYTES) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      maybeUpdatePct(100, true);
    } finally {
      if (monitorTimer) clearInterval(monitorTimer);
    }
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
  renderMicCaptureState();
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
  renderMicCaptureState();

  // Play the most recent speak audio that arrived while recording.
  // Only the latest is played to avoid a cascade of stale messages.
  // Audio in the queue already passed the shouldPlay check when it was queued.
  if (autoreadCb.checked && speakAudioQueue.length > 0) {
    const latest = speakAudioQueue[speakAudioQueue.length - 1];
    speakAudioQueue = [];
    playAudio(latest);
  } else {
    speakAudioQueue = [];
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
function onUserGesture() {
  if (!audioUnlocked) unlockAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  if (!micStreamAcquired && autoListenEnabled) {
    if (navigator.webdriver) return;
    ensureMicStream().then(() => {
      if (autoListenEnabled) micStreamAcquired = true;
    }).catch(() => {});
  }
}
document.addEventListener("touchstart", onUserGesture, { passive: true });
document.addEventListener("pointerdown", onUserGesture, { passive: true });
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
// activePaneSpeech is declared at top-level (shared with Auto Listen OFF shutdown logic).

function stopActivePaneSpeech() {
  if (activePaneSpeech) {
    try { activePaneSpeech.onresult = null; activePaneSpeech.onerror = null; activePaneSpeech.onend = null; } catch {}
    // `abort()` is the most reliable immediate shutdown across browsers.
    try {
      if (typeof activePaneSpeech.abort === "function") activePaneSpeech.abort();
      else activePaneSpeech.stop();
    } catch {}
    activePaneSpeech = null;
    renderMicCaptureState();
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

    // Voice tab: hide bottom controls (Auto-read and Auto Listen toggles are duplicated inside Voice tab).
    if (target === "voice") {
      if (isTextPopoutOpen()) closeTextPopout();
      controlsEl.classList.add("hidden");
    } else {
      controlsEl.classList.remove("hidden");
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
connect();
loadVoiceSummaryHistory();
