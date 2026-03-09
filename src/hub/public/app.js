// Stub removed elements so downstream references don't crash
const terminalEl = { textContent: "", scrollTop: 0, scrollHeight: 0, clientHeight: 0, addEventListener() {}, className: "" };
const summaryEl = document.getElementById("voice-summary"); // still used for voice summary display
const transcriptionEl = { textContent: "", className: "", addEventListener() {} };
const statusEl = document.getElementById("overseer-status") || { textContent: "", className: "" };
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
const autoreadCb = document.getElementById("voice-autoread-cb"); // single source now
const voiceAutoreadCb = document.getElementById("voice-autoread-cb");
const voiceMicBtn = document.getElementById("voice-mic-btn");
const voiceReplayBtn = document.getElementById("voice-replay-btn");
const voiceStatusBtn = document.getElementById("voice-status-btn");
const voiceSummaryEl = document.getElementById("voice-summary");
const voiceTranscriptionEl = document.getElementById("voice-transcription");
const voiceInterruptBtn = document.getElementById("voice-interrupt-btn");
const voiceHistorySelect = document.getElementById("voice-history-select");
const voicePaneTargetEl = document.getElementById("voice-pane-target");
const pendingTasksContentEl = document.getElementById("pending-tasks-content");
const completedTasksContentEl = document.getElementById("completed-tasks-content");
const refreshTasksBtn = document.getElementById("refresh-tasks-btn");
const loginModal = document.getElementById("login-modal");
const loginBackdrop = document.getElementById("login-backdrop");
const loginCloseBtn = document.getElementById("login-close-btn");
const loginStatusText = document.getElementById("login-status-text");
const loginToolSelect = document.getElementById("login-tool-select");
const loginStartBtn = document.getElementById("login-start-btn");
const loginUrlContainer = document.getElementById("login-url-container");
const loginUrlLink = document.getElementById("login-url-link");
const loginCancelBtn = document.getElementById("login-cancel-btn");
// Focused pane for voice input routing
let focusedPaneTarget = null;
let focusedPaneLabel = "";
let lastTtsAudioData = null;
let speakAudioQueue = []; // TTS audio received while mic is held down
let ttsFormat = "mp3";
let ttsMime = "audio/mpeg";
let ttsFormatOverride = null; // set when we detect a format mismatch (e.g., iOS failing Opus)
let pendingTtsTexts = []; // speak_text arrives before the binary audio frame; keep them paired

// ── TTS Playback Queue (FIFO) ────────────────────────────────────────────────
// Declared early because Auto-read is initialized before the Audio element is created,
// and disabling auto-read calls stopTtsPlayback() during initial script evaluation.
const TTS_PLAYBACK_QUEUE_LIMIT = 5;
let ttsPlaybackQueue = []; // [{ id, data:ArrayBuffer, enqueuedAt:number, text?:string, fallbackTried?:boolean }]
let ttsPlaybackNextId = 1;
let ttsPlaybackPlaying = false;
let ttsPlaybackDrainScheduled = false;
let ttsPlaybackCurrentUrl = null;
let ttsPlaybackPlayBlockedAt = 0; // throttle logs if autoplay is blocked
let ttsFormatMismatchAt = 0; // throttle reconnects when we detect an unsupported format

// Core runtime state (declared early so localStorage-driven toggles can safely run on load).
let ws = null;
let mediaRecorder = null;
let recording = false;
let wantRecording = false; // true while user is holding the mic button
let recordingStartTime = 0;
let micStream = null;
let autoScroll = true;
let disconnectedFlashTimer = null;
let lastOverseerUpdateAt = 0;
let overseerName = "";
let statusUpdateTimer = null;
let reconnectTimer = null;
let wsConnectionSeq = 0;
let maxRecordingTimer = null;
let pendingMicReleaseTimer = null;
let activePaneSpeech = null; // Web Speech API recognition (uses mic)

let recordingSessionId = 0; // increments per recording; used to abort onstop side effects
let abortRecordingUpload = false;

let audioCtx = null; // declared early; initialized lazily by getAudioContext()
let silentKeepAliveNode = null; // oscillator used to keep Safari alive in background

function startSilentKeepAlive() {
  if (silentKeepAliveNode) return; // already running
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    silentKeepAliveNode = { oscillator: osc, gain };
  } catch {}
}

function stopSilentKeepAlive() {
  if (!silentKeepAliveNode) return;
  try { silentKeepAliveNode.oscillator.stop(); } catch {}
  try { silentKeepAliveNode.oscillator.disconnect(); } catch {}
  try { silentKeepAliveNode.gain.disconnect(); } catch {}
  silentKeepAliveNode = null;
}

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
      // Opus frames inside an Ogg container.
      return 'audio/ogg; codecs="opus"';
  }
}

function selectBestTtsFormat() {
  // iOS Safari is extremely finicky with Ogg/Opus and can report false positives via canPlayType().
  // Default to MP3 (most compatible), then AAC, and only pick Opus if the browser says "probably".
  const a = new Audio();
  const can = (mime) => {
    if (!a.canPlayType) return "";
    try {
      return a.canPlayType(mime) || "";
    } catch {
      return "";
    }
  };
  const ok = (mime) => {
    const v = can(mime);
    return typeof v === "string" && v.length > 0;
  };
  const probably = (mime) => String(can(mime)).toLowerCase() === "probably";

  // MP3 is the safest baseline on iPhone/iPad and works across basically everything.
  if (ok("audio/mpeg")) return "mp3";

  // iOS Safari sometimes prefers MP4/AAC; OpenAI supports response_format=aac.
  if (ok('audio/mp4; codecs="mp4a.40.2"')) return "aac";
  if (ok("audio/aac")) return "aac";

  // Opus in an Ogg container (what we send for response_format=opus).
  // Only accept "probably" to avoid canPlayType() false positives on Safari.
  if (probably('audio/ogg; codecs="opus"')) return "opus";

  return "mp3";
}

function setLatestVoiceSummary(text) {
  const t = typeof text === "string" ? text : "";
  if (summaryEl) summaryEl.textContent = t;
  if (voiceSummaryEl) voiceSummaryEl.textContent = t;
}

function notifyNativeAutoReadChanged(enabled) {
  try {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.autoReadChanged;
    if (handler && typeof handler.postMessage === "function") {
      handler.postMessage(!!enabled);
    }
  } catch {}
}

// Auto-read toggle: ON by default, persisted in localStorage
function setAutoReadEnabled(enabled, { persist = true, notifyNative = true } = {}) {
  const val = !!enabled;
  if (autoreadCb) autoreadCb.checked = val;
  if (voiceAutoreadCb) voiceAutoreadCb.checked = val;
  if (persist) localStorage.setItem("autoread", String(val));
  if (notifyNative) notifyNativeAutoReadChanged(val);
  if (!val) {
    stopTtsPlayback();
    speakAudioQueue = [];
  }
}

window.setAutoRead = function setAutoRead(enabled) {
  setAutoReadEnabled(enabled, { persist: true, notifyNative: false });
};

const storedAutoread = localStorage.getItem("autoread");
setAutoReadEnabled(storedAutoread === null ? true : storedAutoread === "true", { persist: false, notifyNative: false });
[autoreadCb, voiceAutoreadCb].forEach((cb) => {
  if (!cb) return;
  cb.addEventListener("change", () => setAutoReadEnabled(cb.checked, { persist: true, notifyNative: true }));
});

// Auto Listen is always enabled (toggle removed from UI).
const autoListenEnabled = true;
let micStreamAcquireSeq = 0; // increments to invalidate in-flight getUserMedia() calls

function closeAudioContext() {
  stopSilentKeepAlive();
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

function maybeSendAudioCancel(reason) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Only send cancel when we might have an in-flight upload/recording/session on this socket.
    const shouldCancel = !!(mediaRecorder || recording || wantRecording || isMicStreamLive());
    if (!shouldCancel) return;
    ws.send(JSON.stringify({ type: "audio_cancel", reason: reason || "" }));
  } catch {}
}

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
// Allow test overrides via globals set before app.js loads (addInitScript).
const STT_RESPONSE_TIMEOUT_MS = window.__STT_RESPONSE_TIMEOUT_MS || 15 * 1000;
const STT_TRANSCRIPTION_TIMEOUT_MS = window.__STT_TRANSCRIPTION_TIMEOUT_MS || 90 * 1000;

// Timers for detecting stuck voice pipeline states.
// Cleared when the expected server response arrives.
let sttResponseTimer = null;
let sttTranscriptionTimer = null;

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

function playMicReadyBeep() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046, now); // C6 — bright, clear ready tone
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
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
  // iOS Safari requires each Audio element to be played during a user gesture
  // before it can be used for programmatic playback.  Prime the actual ttsAudio
  // element (not a throwaway) so subsequent ttsAudio.play() calls succeed.
  const prevSrc = ttsAudio.src;
  ttsAudio.src = SILENT_WAV_DATA_URI;
  ttsAudio.play().then(() => {
    audioUnlocked = true;
    try {
      ttsAudio.pause();
      ttsAudio.currentTime = 0;
    } catch {}
    // Restore previous src so it doesn't interfere with pending playback.
    ttsAudio.src = prevSrc || "";
    // If any TTS was queued while autoplay was locked, try draining now.
    drainTtsPlaybackQueueSoon();
  }).catch((err) => {
    // Best-effort only: user can still tap replay, and subsequent gestures may unlock.
    console.warn("Audio unlock primer blocked:", err && err.message ? err.message : "unknown");
    // Even on failure, restore the src.
    ttsAudio.src = prevSrc || "";
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

async function fetchPlaybackOnlyTts(text, format) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const resp = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, text: trimmed, playbackOnly: true, format }),
  });
  if (!resp.ok) return null;
  const audio = await resp.arrayBuffer().catch(() => null);
  if (!audio || audio.byteLength === 0) return null;
  return audio;
}

function isNotSupportedPlaybackError(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  const msg = err && typeof err.message === "string" ? err.message.toLowerCase() : "";
  return name === "NotSupportedError" || msg.includes("not supported") || msg.includes("cannot decode");
}

function ensureMp3TtsAndReconnect() {
  ttsFormatOverride = "mp3";
  ttsFormat = "mp3";
  ttsMime = mimeForTtsFormat("mp3");

  // If we were connected with a bad server-side format (e.g., opus), reconnect so future TTS arrives as mp3.
  const now = Date.now();
  if (now - ttsFormatMismatchAt < 3000) return;
  ttsFormatMismatchAt = now;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}

function evictStaleTtsEntries() {
  const now = Date.now();
  const TTS_STALE_MS = 30000; // drop clips older than 30 seconds
  let dropped = 0;
  while (ttsPlaybackQueue.length > 0 && (now - ttsPlaybackQueue[0].enqueuedAt) > TTS_STALE_MS) {
    ttsPlaybackQueue.shift();
    dropped++;
  }
  if (dropped > 0) {
    console.warn(`TTS: dropped ${dropped} stale clip(s) (older than ${TTS_STALE_MS / 1000}s).`);
  }
}

function enqueueTtsPlayback(data, { reason = "tts", text = "", fallbackTried = false } = {}) {
  if (!data) return;
  // NOTE: We intentionally do NOT drop audio when document.hidden.
  // The 30-second stale entry eviction and queue cap handle cleanup.
  // Dropping here caused audio to silently disappear on mobile whenever
  // the screen dimmed or the user checked notifications.

  evictStaleTtsEntries();

  ttsPlaybackQueue.push({
    id: ttsPlaybackNextId++,
    data,
    enqueuedAt: Date.now(),
    reason,
    text,
    fallbackTried,
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

  evictStaleTtsEntries();
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
    // If the browser cannot decode this format (common on iOS for Ogg/Opus),
    // switch to mp3 and replay the corresponding text via playbackOnly.
    if (isNotSupportedPlaybackError(err) && ttsFormat === "opus" && next.text && !next.fallbackTried) {
      ensureMp3TtsAndReconnect();
      (async () => {
        const mp3 = await fetchPlaybackOnlyTts(next.text, "mp3").catch(() => null);
        if (mp3) {
          enqueueTtsPlayback(mp3, { reason: "fallback_mp3", text: next.text, fallbackTried: true });
          drainTtsPlaybackQueueSoon();
          return;
        }
        // If fallback fails, drop this clip so we don't spin forever.
        console.warn("TTS format mismatch and mp3 fallback failed; dropping clip.");
        onTtsPlaybackFinished("fallback_failed");
      })();
      return;
    }

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

// When the page becomes visible again, evict stale queued clips but keep
// currently-playing audio intact.  The previous approach called stopTtsPlayback()
// which destroyed in-progress playback whenever the user briefly checked
// notifications or the screen dimmed on mobile.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  evictStaleTtsEntries();
  // Also flush any audio held while recording, keeping only the newest.
  if (speakAudioQueue.length > 1) {
    speakAudioQueue = [speakAudioQueue[speakAudioQueue.length - 1]];
  }
  // Kick the drain loop in case playback was deferred while hidden.
  if (!ttsPlaybackPlaying && ttsPlaybackQueue.length > 0) {
    drainTtsPlaybackQueueSoon();
  }
});

function handleIncomingTtsAudio(data, opts = {}) {
  lastTtsAudioData = data;
  voiceReplayBtn.disabled = false;
  if (nativeAppHost) return;
  const autoplay = opts.autoplay !== false;
  if (!autoplay) return;
  // NOTE: We intentionally do NOT check document.hidden here.
  // The TTS queue has its own 30-second stale eviction and cap,
  // so audio won't pile up.  Dropping audio when hidden caused
  // TTS to silently disappear on mobile whenever the screen
  // dimmed or the user briefly checked notifications.

  // Respect the auto-read toggle for autoplay; replay is always available.
  const shouldPlay = autoreadCb.checked;
  if (shouldPlay) {
    if (recording || wantRecording) {
      // Mic is active — hold audio until recording stops
      speakAudioQueue.push(data);
    } else {
      playAudio(data, { text: opts.text || "" });
    }
  }
}

function playAudio(data, { text = "" } = {}) {
  enqueueTtsPlayback(data, { reason: "playAudio", text });
}

// Snapshot rendering removed (terminal tab removed); keep variable for compat
let pendingSnapshot = null;

const urlParams = new URLSearchParams(location.search);
const token = urlParams.get("token") || "";
const nativeAppHost = urlParams.get("nativeApp") === "1";
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

// Terminal scroll handler removed (terminal tab removed)

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h + "h ago";
}

function updateStatusTimer() {
  if (!statusEl || statusEl.className !== "connected") return;
  if (!lastOverseerUpdateAt) {
    statusEl.textContent = overseerName + " (waiting\u2026)";
  } else {
    statusEl.textContent = overseerName + " (" + formatElapsed(Date.now() - lastOverseerUpdateAt) + ")";
  }
}

function startStatusTimer() {
  if (statusUpdateTimer) clearInterval(statusUpdateTimer);
  statusUpdateTimer = setInterval(updateStatusTimer, 1000);
}

function stopStatusTimer() {
  if (statusUpdateTimer) {
    clearInterval(statusUpdateTimer);
    statusUpdateTimer = null;
  }
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const desiredTts = ttsFormatOverride || selectBestTtsFormat();
  // Best-effort: set defaults before the server sends tts_config.
  ttsFormat = desiredTts;
  ttsMime = mimeForTtsFormat(desiredTts);
  // Explicitly use window.WebSocket so Playwright tests can stub it reliably.
  const WebSocketCtor = window.WebSocket || WebSocket;
  const socket = new WebSocketCtor(
    `${proto}//${location.host}?token=${encodeURIComponent(token)}&tts=${encodeURIComponent(desiredTts)}`
  );
  const connSeq = ++wsConnectionSeq;
  ws = socket;
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    if (connSeq !== wsConnectionSeq || ws !== socket) return;
    statusEl.textContent = "connecting...";
    statusEl.className = "disconnected";
    // Re-send projects tab state on reconnect
    if (projectsTabActive) {
      socket.send(JSON.stringify({ type: "status_tab_active" }));
    }
  };

  socket.onmessage = async (evt) => {
    if (connSeq !== wsConnectionSeq || ws !== socket) return;
    // Any binary frame from server = TTS audio, store for replay and maybe autoplay.
    if (evt.data instanceof ArrayBuffer) {
      const text = pendingTtsTexts.length ? pendingTtsTexts.shift() : "";
      handleIncomingTtsAudio(evt.data, { text });
      return;
    }
    if (evt.data instanceof Blob) {
      const buf = await evt.data.arrayBuffer().catch(() => null);
      if (!buf) return;
      const text = pendingTtsTexts.length ? pendingTtsTexts.shift() : "";
      handleIncomingTtsAudio(buf, { text });
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
        overseerName = msg.overseer || "connected";
        lastOverseerUpdateAt = Date.now();
        statusEl.className = "connected";
        updateStatusTimer();
        startStatusTimer();
        if (msg.lastSpeakText) setLatestVoiceSummary(msg.lastSpeakText);
        break;

      case "tts_config":
        if (msg && typeof msg.format === "string") ttsFormat = msg.format;
        if (msg && typeof msg.mime === "string") ttsMime = msg.mime;
        break;

      case "tmux_snapshot":
        // Terminal tab removed; just update timestamp
        lastOverseerUpdateAt = Date.now();
        break;

      case "speak_text":
        lastOverseerUpdateAt = Date.now();
        if (msg.text) {
          setLatestVoiceSummary(msg.text);
          prependVoiceSummaryEntry({
            text: msg.text,
            timestamp: msg.timestamp,
          });
          // Maintain FIFO pairing between speak_text and subsequent binary audio frame.
          pendingTtsTexts.push(String(msg.text || ""));
        }
        break;
      case "voice_history":
        setVoiceSummaryHistory(msg.entries || []);
        break;

      case "transcription":
        lastOverseerUpdateAt = Date.now();
        clearSttTimers();
        transcriptionEl.textContent = msg.text;
        transcriptionEl.className = "";
        voiceTranscriptionEl.textContent = "Sent";
        voiceTranscriptionEl.className = "voice-transcription";
        addMessageToHistory(msg.text);
        break;

      case "transcribing":
        clearSttTimers();
        showTranscribingIndicator();
        // Start a timeout for the transcription phase itself.
        sttTranscriptionTimer = setTimeout(() => {
          sttTranscriptionTimer = null;
          if (transcriptionEl.textContent === "Transcribing...") {
            showSttError("Transcription timed out — try again");
          }
        }, STT_TRANSCRIPTION_TIMEOUT_MS);
        break;

      case "stt_error":
        clearSttTimers();
        transcriptionEl.textContent = msg.message;
        transcriptionEl.className = "error";
        voiceTranscriptionEl.textContent = "Error";
        voiceTranscriptionEl.className = "voice-transcription error";
        playDing(false);
        break;

      case "status_stream_update":
        lastOverseerUpdateAt = Date.now();
        renderStreamUpdate(msg);
        break;

      case "error":
        summaryEl.textContent = "Error: " + msg.message;
        break;
    }
  };

  socket.onclose = () => {
    if (connSeq !== wsConnectionSeq || ws !== socket) return;
    clearSttTimers();
    stopStatusTimer();
    lastOverseerUpdateAt = 0;
    overseerName = "";
    statusEl.textContent = "disconnected";
    statusEl.className = "disconnected";
    // Reset audio unlock so next user gesture re-primes the Audio element
    audioUnlocked = false;
    reconnectTimer = setTimeout(connect, 2000);
  };

  socket.onerror = () => {
    if (connSeq !== wsConnectionSeq || ws !== socket) return;
    socket.close();
  };
}

// Acquire mic stream on demand for push-to-talk
async function ensureMicStream() {
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

// Text command (bottom bar removed; sendTextCommand still used by voice status/history)
function sendText() {
  // No-op: bottom controls removed
}

function isTextPopoutOpen() {
  return textPopoutModal && !textPopoutModal.classList.contains("hidden");
}

function closeTextPopout({ sent = false } = {}) {
  if (!textPopoutModal || !textPopoutTextarea) return;
  textPopoutModal.classList.add("hidden");
  textPopoutModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("text-popout-open");
}

function openTextPopout() {
  if (!textPopoutModal || !textPopoutTextarea) return;
  textPopoutTextarea.value = "";
  textPopoutModal.classList.remove("hidden");
  textPopoutModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("text-popout-open");
  setTimeout(() => {
    textPopoutTextarea.focus();
  }, 0);
}

function sendTextFromPopout() {
  if (!textPopoutTextarea) return;
  unlockAudio();
  const text = textPopoutTextarea.value.trim();
  if (!text) return;
  // Route to focused pane if available, otherwise use legacy text_command
  if (focusedPaneTarget) {
    sendPaneText(focusedPaneTarget, text);
  } else {
    sendTextCommand(text);
  }
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

function showSttError(message) {
  clearSttTimers();
  transcriptionEl.textContent = message;
  transcriptionEl.className = "error";
  voiceTranscriptionEl.textContent = "Error";
  voiceTranscriptionEl.className = "voice-transcription error";
  playDing(false);
}

function clearSttTimers() {
  if (sttResponseTimer) { clearTimeout(sttResponseTimer); sttResponseTimer = null; }
  if (sttTranscriptionTimer) { clearTimeout(sttTranscriptionTimer); sttTranscriptionTimer = null; }
}

// Bottom bar sendBtn/textInput removed; text popout still available for pane use
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
    return;
  }
  if (e.key === "Escape" && isLoginModalOpen()) {
    e.preventDefault();
    closeLoginModal();
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

// Mic recording — acquires stream on demand for push-to-talk
function startRecording() {
  if (pendingMicReleaseTimer) {
    clearTimeout(pendingMicReleaseTimer);
    pendingMicReleaseTimer = null;
  }
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

    // Clear any lingering STT timers from a previous recording before starting
    // a new upload cycle (prevents a stale timer from falsely tripping).
    clearSttTimers();
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
        // Detect dead socket during drain (e.g. iOS backgrounding killed it).
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn("[voice] WebSocket closed during upload drain");
          showSttError("Connection lost during upload — try again");
          return;
        }
        const bufferedDelta = Math.max(0, ws.bufferedAmount - baseBufferedAmount);
        if (bufferedDelta <= DRAIN_EPSILON_BYTES) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      maybeUpdatePct(100, true);

      // Start a fallback timer: if the server never sends "transcribing" (or any
      // terminal STT response), the client would be stuck at "Uploading... 100%"
      // forever.  This covers silent WebSocket drops, server crashes, etc.
      if (sttResponseTimer) clearTimeout(sttResponseTimer);
      sttResponseTimer = setTimeout(() => {
        sttResponseTimer = null;
        // Only act if we're still showing the uploading indicator.
        if (transcriptionEl.textContent.startsWith("Uploading")) {
          showSttError("Upload timed out — try again");
        }
      }, STT_RESPONSE_TIMEOUT_MS);
    } finally {
      if (monitorTimer) clearInterval(monitorTimer);
    }
  };

  mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);
  playMicReadyBeep();
  recording = true;
  recordingStartTime = Date.now();
  if (maxRecordingTimer) clearTimeout(maxRecordingTimer);
  maxRecordingTimer = setTimeout(() => {
    if (recording || wantRecording) stopRecording();
  }, MAX_RECORDING_MS);
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
  voiceMicBtn.classList.remove("recording");
  renderMicCaptureState();

  // Release mic after a short delay so MediaRecorder onstop handler can read the stream.
  if (pendingMicReleaseTimer) {
    clearTimeout(pendingMicReleaseTimer);
  }
  const releaseSessionId = recordingSessionId;
  pendingMicReleaseTimer = setTimeout(() => {
    pendingMicReleaseTimer = null;
    if (releaseSessionId !== recordingSessionId) return;
    stopMicStream();
  }, 500);

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

// Bottom bar mic button removed; voice tab mic button still active below

// Voice tab mic button
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

// Voice status button — ask focused pane for a status update
voiceStatusBtn.addEventListener("click", () => {
  audioUnlocked = true;
  playDing(true);
  if (focusedPaneTarget) {
    sendPaneText(focusedPaneTarget, "Give me a status update");
  } else {
    sendTextCommand("Give me a status update on all the tasks");
  }
});

// Unlock audio + start silent keep-alive on user interaction.
// Not once-only: after WS reconnect audioUnlocked resets, so we need subsequent
// gestures to re-prime the Audio element for autoplay.
function onUserGesture() {
  if (!audioUnlocked) unlockAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  startSilentKeepAlive();
}
document.addEventListener("touchstart", onUserGesture, { passive: true });
document.addEventListener("pointerdown", onUserGesture, { passive: true });
document.addEventListener("click", onUserGesture);

// Interrupt — send Ctrl+C to focused pane (or overseer fallback)
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

voiceInterruptBtn.addEventListener("click", sendInterrupt);

// Captain restart/switch UI removed (terminal tab removed)

function setButtonLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (label) {
    label.textContent = text;
  } else {
    btn.textContent = text;
  }
}

// --- Login flow ---
let loginPollTimer = null;

function isLoginModalOpen() {
  return loginModal && !loginModal.classList.contains("hidden");
}

function openLoginModal() {
  if (!loginModal) return;
  loginStatusText.textContent = "Select a tool and start the login flow.";
  loginUrlContainer.classList.add("hidden");
  loginCancelBtn.classList.add("hidden");
  loginStartBtn.disabled = false;
  loginStartBtn.textContent = "Start Login";
  loginToolSelect.disabled = false;
  loginModal.classList.remove("hidden");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("login-modal-open");
}

function closeLoginModal() {
  if (!loginModal) return;
  loginModal.classList.add("hidden");
  loginModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("login-modal-open");
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

async function startLogin() {
  const tool = loginToolSelect.value;
  loginStartBtn.disabled = true;
  loginStartBtn.textContent = "Starting...";
  loginToolSelect.disabled = true;
  loginStatusText.textContent = "Starting login...";
  loginUrlContainer.classList.add("hidden");

  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tool }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      loginStatusText.textContent = "Error: " + (data.error || "Request failed");
      loginStartBtn.disabled = false;
      loginStartBtn.textContent = "Start Login";
      loginToolSelect.disabled = false;
      playDing(false);
      return;
    }
    loginStatusText.textContent = "Waiting for OAuth URL...";
    loginCancelBtn.classList.remove("hidden");
    pollLoginStatus();
  } catch (err) {
    loginStatusText.textContent = "Error: " + (err.message || "Network error");
    loginStartBtn.disabled = false;
    loginStartBtn.textContent = "Start Login";
    loginToolSelect.disabled = false;
    playDing(false);
  }
}

function pollLoginStatus() {
  if (loginPollTimer) clearInterval(loginPollTimer);
  loginPollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/login-status?token=${encodeURIComponent(token)}`);
      if (!resp.ok) return;
      const data = await resp.json();

      switch (data.status) {
        case "waiting_for_auth":
          if (data.url) {
            loginUrlLink.href = data.url;
            loginUrlLink.textContent = data.url;
            loginUrlContainer.classList.remove("hidden");
            loginStatusText.textContent = "Open the link below to authenticate:";
          }
          break;
        case "success":
          clearInterval(loginPollTimer);
          loginPollTimer = null;
          loginStatusText.textContent = "Login successful!";
          loginUrlContainer.classList.add("hidden");
          loginCancelBtn.classList.add("hidden");
          loginStartBtn.disabled = false;
          loginStartBtn.textContent = "Start Login";
          loginToolSelect.disabled = false;
          playDing(true);
          break;
        case "error":
          clearInterval(loginPollTimer);
          loginPollTimer = null;
          loginStatusText.textContent = "Login failed: " + (data.error || "Unknown error");
          loginUrlContainer.classList.add("hidden");
          loginCancelBtn.classList.add("hidden");
          loginStartBtn.disabled = false;
          loginStartBtn.textContent = "Start Login";
          loginToolSelect.disabled = false;
          playDing(false);
          break;
      }
    } catch {}
  }, 1000);
}

if (loginStartBtn) loginStartBtn.addEventListener("click", startLogin);
if (loginCloseBtn) loginCloseBtn.addEventListener("click", closeLoginModal);
if (loginBackdrop) loginBackdrop.addEventListener("click", closeLoginModal);
if (loginCancelBtn) loginCancelBtn.addEventListener("click", closeLoginModal);

// --- Tab switching ---
const tabs = document.querySelectorAll("#tab-bar .tab");
const tabContents = document.querySelectorAll(".tab-content");
const tabBarEl = document.getElementById("tab-bar");

let projectsTabActive = false;

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
  // Clear focused pane unless a pane is zoomed
  if (!zoomedPaneKey) setFocusedPane(null, "");
}


function scrollActiveTabIntoView(tab, smooth = false) {
  if (!tabBarEl || !tab) return;
  tab.scrollIntoView({
    block: "nearest",
    inline: "center",
    behavior: smooth ? "smooth" : "auto",
  });
}

function sendProjectsTabState(active) {
  projectsTabActive = active;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: active ? "status_tab_active" : "status_tab_inactive" }));
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    const smoothScroll = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wasProjects = document.getElementById("projects-view").classList.contains("active");
    const wasOverseer = document.getElementById("overseer-view").classList.contains("active");
    const wasTasks = document.getElementById("tasks-view").classList.contains("active");
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    scrollActiveTabIntoView(tab, smoothScroll);
    tabContents.forEach((c) => {
      c.classList.toggle("active", c.id === target + "-view");
    });
    // Notify server about projects tab activation/deactivation
    if (target === "projects" && !wasProjects) sendProjectsTabState(true);
    if (target !== "projects" && wasProjects) { sendProjectsTabState(false); closeActivePaneInteract(); }

    // Auto-scroll all expanded panels to bottom when switching to Projects tab
    if (target === "projects") {
      for (const [, entry] of panelMap) {
        if (!entry.panel.classList.contains("collapsed")) {
          entry.pre.scrollTop = entry.pre.scrollHeight;
        }
      }
    }

    // Voice tab
    if (target === "voice") {
      if (isTextPopoutOpen()) closeTextPopout();
    }

    // Overseer tab: auto-refresh voice history on tab switch
    if (target === "overseer" && !wasOverseer) refreshOverseer();
    if (target === "tasks" && !wasTasks) refreshTasks();
  });
});

scrollActiveTabIntoView(document.querySelector("#tab-bar .tab.active"));

// --- Projects tab (live streaming) ---
const projectsTimeEl = document.getElementById("projects-time");
const projectsPanesEl = document.getElementById("projects-panes");

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

  // Set focused pane for voice routing
  setFocusedPane(entry.target, label);

  // Autofocus on open (mobile-friendly)
  setTimeout(() => {
    try {
      entry.input.focus();
    } catch {}
  }, 0);
}

document.addEventListener("pointerdown", (e) => {
  if (!document.getElementById("projects-view").classList.contains("active")) return;
  if (!activePaneInteract) return;
  const t = e.target;
  if (activePaneInteract.overlay && activePaneInteract.overlay.contains(t)) return;
  if (activePaneInteract.panel && activePaneInteract.panel.contains(t)) return;
  closeActivePaneInteract();
});

// Project section management
const projectSectionMap = new Map(); // projectName -> { section, body }

function ensureProjectSection(projectName, isOverseer) {
  let entry = projectSectionMap.get(projectName);
  if (entry) return entry;

  const section = document.createElement("div");
  section.className = "project-section";

  const header = document.createElement("div");
  header.className = "project-section-header";

  const nameEl = document.createElement("span");
  nameEl.className = "project-section-name" + (isOverseer ? " overseer-label" : "");
  nameEl.textContent = projectName;
  header.appendChild(nameEl);

  if (!isOverseer) {
    const addWorkerBtn = document.createElement("button");
    addWorkerBtn.className = "project-add-worker-btn";
    addWorkerBtn.title = "Add worker";
    addWorkerBtn.textContent = "+";
    addWorkerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCreateWorkerModal(projectName);
    });
    header.appendChild(addWorkerBtn);

    const stopBtn = document.createElement("button");
    stopBtn.className = "project-stop-btn";
    stopBtn.title = "Stop project";
    stopBtn.textContent = "\u2212"; // minus sign
    stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Stop project "${projectName}"? This will kill all its workers.`)) {
        deleteProject(projectName);
      }
    });
    header.appendChild(stopBtn);
  }

  header.addEventListener("click", () => {
    section.classList.toggle("collapsed");
  });

  const body = document.createElement("div");
  body.className = "project-section-body";

  section.appendChild(header);
  section.appendChild(body);
  projectsPanesEl.appendChild(section);

  entry = { section, body, name: projectName };
  projectSectionMap.set(projectName, entry);
  return entry;
}

async function deleteProject(name) {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Request failed" }));
      alert("Failed to stop project: " + (err.error || "Unknown error"));
    }
  } catch (err) {
    alert("Failed to stop project: " + err.message);
  }
}

function renderStreamUpdate(data) {
  if (!data.sessions || data.sessions.length === 0) {
    projectsTimeEl.textContent = "no sessions";
    projectsTimeEl.className = "";
    for (const [, entry] of panelMap) entry.panel.remove();
    panelMap.clear();
    for (const [, entry] of projectSectionMap) entry.section.remove();
    projectSectionMap.clear();
    closeActivePaneInteract();
    if (!projectsPanesEl.querySelector(".status-empty")) {
      projectsPanesEl.innerHTML = '<div class="status-empty">No active projects</div>';
    }
    return;
  }

  projectsTimeEl.textContent = "\u25CF LIVE";
  projectsTimeEl.className = "live-indicator";

  const emptyMsg = projectsPanesEl.querySelector(".status-empty");
  if (emptyMsg) emptyMsg.remove();

  const currentKeys = new Set();
  const activeProjects = new Set();

  // Group sessions by project
  for (const session of data.sessions) {
    const slashIdx = session.name.indexOf("/");
    const projectName = slashIdx > 0 ? session.name.slice(0, slashIdx) : null;
    const isOverseer = !projectName;
    const displayProject = projectName || "Captain";

    activeProjects.add(displayProject);
    const projectEntry = ensureProjectSection(displayProject, isOverseer);

    for (const win of (session.windows || [])) {
      const panes = Array.isArray(win.panes) && win.panes.length
        ? win.panes
        : [{ index: 0, target: `${session.name}:0.0`, content: win.content || "" }];

      for (const pane of panes) {
        const key = `${session.name}\t${win.name}\t${pane.target || pane.id || pane.index}`;
        currentKeys.add(key);

        let entry = panelMap.get(key);
        if (!entry) {
          const panel = document.createElement("div");
          panel.className = "stream-panel";

          const header = document.createElement("div");
          header.className = "stream-panel-header";
          const sessionLabel = slashIdx > 0 ? session.name.slice(slashIdx + 1) : session.name;
          header.textContent = `${sessionLabel} / ${win.name} \u00B7 pane ${pane.index}`;
          header.title = pane.target || "";
          header.addEventListener("click", () => {
            if (zoomedPaneKey === key) {
              unzoomPane();
              return;
            }
            panel.classList.toggle("collapsed");
            if (!panel.classList.contains("collapsed")) {
              pre.scrollTop = pre.scrollHeight;
            }
          });
          header.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            zoomPane(key);
          });
          panel.appendChild(header);

          const pre = document.createElement("pre");
          pre.className = "stream-panel-content";
          pre.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const current = panelMap.get(key);
            if (current) {
              openPaneInteract(current, `${session.name} / ${win.name} \u00B7 ${current.target || ""}`);
            }
          });
          panel.appendChild(pre);

          projectEntry.body.appendChild(panel);
          entry = {
            key,
            panel,
            pre,
            target: pane.target,
            projectName: displayProject,
            lastContent: "",
            overlay: null,
            input: null,
            statusEl: null,
          };
          panelMap.set(key, entry);
        } else {
          entry.target = pane.target;
          // Re-parent if needed (shouldn't normally change)
          if (entry.panel.parentElement !== projectEntry.body) {
            projectEntry.body.appendChild(entry.panel);
          }
        }

        const content = pane.content || "";
        if (content !== entry.lastContent) {
          updatePaneActivity(key);
          const wasAtBottom =
            entry.pre.scrollHeight - entry.pre.scrollTop - entry.pre.clientHeight < 40;
          // Show last ~20 lines by default; full content when zoomed
          const lines = content.split("\n");
          const isZoomed = zoomedPaneKey === key;
          const displayContent = (!isZoomed && lines.length > 20)
            ? lines.slice(-20).join("\n")
            : content;
          entry.pre.textContent = displayContent;
          entry.lastContent = content;
          if (wasAtBottom) {
            entry.pre.scrollTop = entry.pre.scrollHeight;
          }
        }
      }
    }
  }

  // Remove stale panes
  for (const [key, entry] of panelMap) {
    if (!currentKeys.has(key)) {
      if (activePaneInteract && activePaneInteract.key === key) closeActivePaneInteract();
      if (zoomedPaneKey === key) unzoomPane();
      entry.panel.remove();
      panelMap.delete(key);
      paneLastChangeAt.delete(key);
    }
  }

  // Remove stale project sections
  for (const [name, entry] of projectSectionMap) {
    if (!activeProjects.has(name)) {
      entry.section.remove();
      projectSectionMap.delete(name);
    }
  }
}
// --- Overseer tab (voice history view) ---
const overseerTabContentEl = document.getElementById("overseer-tab-content");
const refreshOverseerBtn = document.getElementById("refresh-overseer-btn");

function renderOverseerHistory() {
  if (!overseerTabContentEl) return;
  if (!voiceSummaryHistory || voiceSummaryHistory.length === 0) {
    overseerTabContentEl.innerHTML = '<div class="overseer-empty">No voice history entries yet.</div>';
    return;
  }
  // Show entries in reverse chronological order (newest first — already sorted)
  const container = document.createElement("div");
  container.className = "overseer-history-list";
  for (const entry of voiceSummaryHistory) {
    const item = document.createElement("div");
    item.className = "overseer-history-entry";

    const ts = document.createElement("div");
    ts.className = "overseer-history-time";
    ts.textContent = formatVoiceHistoryTimestamp(entry.timestamp);

    const txt = document.createElement("div");
    txt.className = "overseer-history-text";
    txt.textContent = entry.text;

    item.appendChild(ts);
    item.appendChild(txt);
    container.appendChild(item);
  }
  overseerTabContentEl.innerHTML = "";
  overseerTabContentEl.appendChild(container);
}

async function refreshOverseer() {
  if (!refreshOverseerBtn) return;
  if (refreshOverseerBtn.disabled) return;

  refreshOverseerBtn.disabled = true;
  refreshOverseerBtn.textContent = "Loading...";

  try {
    await loadVoiceSummaryHistory();
    renderOverseerHistory();
  } finally {
    refreshOverseerBtn.disabled = false;
    refreshOverseerBtn.textContent = "Refresh";
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

function formatTimestamp(iso) {
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

const formatCompletedAt = formatTimestamp;

function formatDuration(startIso, endIso) {
  const start = Date.parse(startIso || "");
  const end = Date.parse(endIso || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m " + (secs % 60) + "s";
  const hrs = Math.floor(mins / 60);
  return hrs + "h " + (mins % 60) + "m";
}

function pendingPreview(content) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "(No task content)";
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 180)}...`;
}

function renderPendingTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    pendingTasksContentEl.innerHTML = '<div class="pending-empty">No pending tasks.</div>';
    return;
  }

  const list = document.createElement("div");
  list.className = "pending-task-list";

  for (const task of tasks) {
    const item = document.createElement("details");
    item.className = "pending-task-item";

    const summary = document.createElement("summary");
    summary.className = "pending-task-summary";

    const heading = document.createElement("div");
    heading.className = "pending-task-heading";
    heading.textContent = `${task.task_name || "unnamed-task"} · ${formatTimestamp(task.created_at)}`;

    const preview = document.createElement("div");
    preview.className = "pending-task-preview";
    preview.textContent = pendingPreview(task.content);

    summary.appendChild(heading);
    summary.appendChild(preview);
    item.appendChild(summary);

    const body = document.createElement("div");
    body.className = "pending-task-body";
    const content = document.createElement("div");
    content.className = "pending-task-content";
    content.innerHTML = mdToHtml(String(task.content || ""));
    body.appendChild(content);

    if (task.worker_status) {
      const statusSection = document.createElement("div");
      statusSection.className = "worker-status-section";
      const statusHeading = document.createElement("div");
      statusHeading.className = "worker-status-heading";
      statusHeading.textContent = "Worker Status";
      const statusContent = document.createElement("div");
      statusContent.className = "worker-status-content";
      statusContent.innerHTML = mdToHtml(task.worker_status);
      statusSection.appendChild(statusHeading);
      statusSection.appendChild(statusContent);
      body.appendChild(statusSection);
    }

    item.appendChild(body);
    list.appendChild(item);
  }

  pendingTasksContentEl.innerHTML = "";
  pendingTasksContentEl.appendChild(list);
}

function renderCompletedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    completedTasksContentEl.innerHTML = '<div class="completed-empty">No completed tasks yet.</div>';
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
    heading.textContent = `${task.title || task.task_name || "unnamed-task"} · ${formatTimestamp(task.completed_at)}`;

    const timeInfo = document.createElement("div");
    timeInfo.className = "completed-task-short";
    const parts = [];
    if (task.started_at) parts.push("started " + formatCompletedAt(task.started_at));
    if (task.completed_at) parts.push("done " + formatCompletedAt(task.completed_at));
    const dur = formatDuration(task.started_at, task.completed_at);
    if (dur) parts.push("(" + dur + ")");
    timeInfo.textContent = parts.join(" \u00b7 ") || "no timing info";

    summary.appendChild(heading);
    summary.appendChild(timeInfo);

    if (task.summary) {
      const summaryText = document.createElement("div");
      summaryText.className = "completed-task-summary-text";
      summaryText.innerHTML = mdToHtml(task.summary);
      summary.appendChild(summaryText);
    }

    item.appendChild(summary);

    const body = document.createElement("div");
    body.className = "completed-task-body";

    if (task.results) {
      const results = document.createElement("div");
      results.className = "completed-task-detailed";
      results.innerHTML = mdToHtml(task.results);
      body.appendChild(results);
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

    if (task.has_log) {
      const logDetails = document.createElement("details");
      logDetails.className = "task-definition-details";
      const logSummary = document.createElement("summary");
      logSummary.textContent = "Full log";
      const logBody = document.createElement("pre");
      logBody.className = "task-log-body";
      logBody.textContent = "Click to load...";
      logDetails.appendChild(logSummary);
      logDetails.appendChild(logBody);

      let logLoaded = false;
      logDetails.addEventListener("toggle", async () => {
        if (!logDetails.open || logLoaded) return;
        logLoaded = true;
        logBody.textContent = "Loading...";
        try {
          const resp = await fetch(
            `/api/task-log?token=${encodeURIComponent(token)}&task=${encodeURIComponent(task.task_name)}`
          );
          if (!resp.ok) {
            logBody.textContent = "Failed to load log.";
            logLoaded = false;
            return;
          }
          const data = await resp.json();
          logBody.textContent = data.log || "(empty log)";
        } catch {
          logBody.textContent = "Failed to load log.";
          logLoaded = false;
        }
      });

      body.appendChild(logDetails);
    }

    item.appendChild(body);
    list.appendChild(item);
  }

  completedTasksContentEl.innerHTML = "";
  completedTasksContentEl.appendChild(list);
}

async function refreshTasks() {
  if (refreshTasksBtn.disabled) return;

  refreshTasksBtn.disabled = true;
  refreshTasksBtn.textContent = "Loading...";
  pendingTasksContentEl.innerHTML = '<div class="pending-loading">Loading pending tasks...</div>';
  completedTasksContentEl.innerHTML = '<div class="completed-loading">Loading completed tasks...</div>';

  try {
    const [pendingResp, completedResp] = await Promise.all([
      fetch(`/api/pending-tasks?token=${encodeURIComponent(token)}&worker_status=1`),
      fetch(`/api/completed-tasks?token=${encodeURIComponent(token)}`),
    ]);

    if (pendingResp.ok) {
      const pendingData = await pendingResp.json();
      renderPendingTasks(pendingData.tasks || []);
    } else {
      const err = await pendingResp.json().catch(() => ({ error: "Request failed" }));
      pendingTasksContentEl.innerHTML = '<div class="pending-error">Error: ' +
        escapeHtml(err.error || "Request failed") + "</div>";
    }

    if (completedResp.ok) {
      const completedData = await completedResp.json();
      renderCompletedTasks(completedData.tasks || []);
    } else {
      const err = await completedResp.json().catch(() => ({ error: "Request failed" }));
      completedTasksContentEl.innerHTML = '<div class="completed-error">Error: ' +
        escapeHtml(err.error || "Request failed") + "</div>";
    }
  } catch (err) {
    pendingTasksContentEl.innerHTML = '<div class="pending-error">Error: ' +
      escapeHtml(err.message || "Request failed") + "</div>";
    completedTasksContentEl.innerHTML = '<div class="completed-error">Error: ' +
      escapeHtml(err.message || "Request failed") + "</div>";
  } finally {
    refreshTasksBtn.disabled = false;
    refreshTasksBtn.textContent = "Refresh";
  }
}

if (refreshOverseerBtn) refreshOverseerBtn.addEventListener("click", refreshOverseer);
refreshTasksBtn.addEventListener("click", refreshTasks);

renderMessageHistorySelect();
connect();
loadVoiceSummaryHistory();

// --- Create Project Modal ---
const createProjectModal = document.getElementById("create-project-modal");
const createProjectBackdrop = document.getElementById("create-project-backdrop");
const createProjectClose = document.getElementById("create-project-close");
const createProjectCancel = document.getElementById("create-project-cancel");
const createProjectSubmit = document.getElementById("create-project-submit");
const createProjectName = document.getElementById("create-project-name");
const createProjectRepo = document.getElementById("create-project-repo");
const createProjectError = document.getElementById("create-project-error");
const addProjectBtn = document.getElementById("add-project-btn");

function openCreateProjectModal() {
  if (!createProjectModal) return;
  createProjectName.value = "";
  if (createProjectRepo) createProjectRepo.value = "";
  createProjectError.classList.add("hidden");
  createProjectError.textContent = "";
  createProjectSubmit.disabled = false;
  createProjectSubmit.textContent = "Create";
  createProjectModal.classList.remove("hidden");
  createProjectModal.setAttribute("aria-hidden", "false");
  setTimeout(() => createProjectName.focus(), 0);
}

function closeCreateProjectModal() {
  if (!createProjectModal) return;
  createProjectModal.classList.add("hidden");
  createProjectModal.setAttribute("aria-hidden", "true");
}

async function submitCreateProject() {
  const name = (createProjectName.value || "").trim();
  const repo = createProjectRepo ? (createProjectRepo.value || "").trim() : "";

  if (!name) {
    createProjectError.textContent = "Project name is required";
    createProjectError.classList.remove("hidden");
    return;
  }

  createProjectError.classList.add("hidden");
  createProjectSubmit.disabled = true;
  createProjectSubmit.textContent = "Creating...";

  try {
    const body = { token, name };
    if (repo) body.repo = repo;
    const resp = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (!resp.ok) {
      createProjectError.textContent = json.error || "Failed to create project";
      createProjectError.classList.remove("hidden");
      return;
    }
    closeCreateProjectModal();
  } catch (err) {
    createProjectError.textContent = err.message || "Network error";
    createProjectError.classList.remove("hidden");
  } finally {
    createProjectSubmit.disabled = false;
    createProjectSubmit.textContent = "Create";
  }
}

if (addProjectBtn) addProjectBtn.addEventListener("click", openCreateProjectModal);
if (createProjectClose) createProjectClose.addEventListener("click", closeCreateProjectModal);
if (createProjectCancel) createProjectCancel.addEventListener("click", closeCreateProjectModal);
if (createProjectBackdrop) createProjectBackdrop.addEventListener("click", closeCreateProjectModal);
if (createProjectSubmit) createProjectSubmit.addEventListener("click", submitCreateProject);
if (createProjectName) {
  createProjectName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitCreateProject(); }
    if (e.key === "Escape") { e.preventDefault(); closeCreateProjectModal(); }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && createProjectModal && !createProjectModal.classList.contains("hidden")) {
    e.preventDefault();
    closeCreateProjectModal();
  }
});

// Fetch build version and display in projects header
(function fetchBuildVersion() {
  // build-version element was in the removed terminal header; skip if missing
  var versionEl = document.getElementById("build-version");
  if (!versionEl) return;
  fetch("/api/version")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var parts = [];
      if (data.build_time && data.build_time !== "unknown") {
        var d = new Date(data.build_time);
        if (!isNaN(d.getTime())) {
          var diff = Date.now() - d.getTime();
          if (diff < 60000) parts.push("built <1m ago");
          else if (diff < 3600000) parts.push("built " + Math.floor(diff / 60000) + "m ago");
          else if (diff < 86400000) parts.push("built " + Math.floor(diff / 3600000) + "h ago");
          else parts.push("built " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
        }
      }
      if (data.git_commit && data.git_commit !== "unknown") {
        parts.push(data.git_commit.slice(0, 7));
      }
      if (parts.length) versionEl.textContent = parts.join(" \u00b7 ");
    })
    .catch(function () { /* ignore */ });
})();

// --- Create Worker Modal ---
const createWorkerModal = document.getElementById("create-worker-modal");
const createWorkerBackdrop = document.getElementById("create-worker-backdrop");
const createWorkerClose = document.getElementById("create-worker-close");
const createWorkerCancel = document.getElementById("create-worker-cancel");
const createWorkerSubmit = document.getElementById("create-worker-submit");
const createWorkerProject = document.getElementById("create-worker-project");
const createWorkerName = document.getElementById("create-worker-name");
const createWorkerTool = document.getElementById("create-worker-tool");
const createWorkerPrompt = document.getElementById("create-worker-prompt");
const createWorkerError = document.getElementById("create-worker-error");

function openCreateWorkerModal(projectName) {
  if (!createWorkerModal) return;
  if (createWorkerProject) createWorkerProject.value = projectName || "";
  if (createWorkerName) createWorkerName.value = "";
  if (createWorkerPrompt) createWorkerPrompt.value = "";
  if (createWorkerError) { createWorkerError.classList.add("hidden"); createWorkerError.textContent = ""; }
  if (createWorkerSubmit) { createWorkerSubmit.disabled = false; createWorkerSubmit.textContent = "Create"; }
  createWorkerModal.classList.remove("hidden");
  createWorkerModal.setAttribute("aria-hidden", "false");
  setTimeout(() => { if (createWorkerName) createWorkerName.focus(); }, 0);
}

function closeCreateWorkerModal() {
  if (!createWorkerModal) return;
  createWorkerModal.classList.add("hidden");
  createWorkerModal.setAttribute("aria-hidden", "true");
}

async function submitCreateWorker() {
  const project = createWorkerProject ? createWorkerProject.value.trim() : "";
  const name = createWorkerName ? createWorkerName.value.trim() : "";
  const tool = createWorkerTool ? createWorkerTool.value : "codex";
  const prompt = createWorkerPrompt ? createWorkerPrompt.value.trim() : "";

  if (!name) {
    if (createWorkerError) {
      createWorkerError.textContent = "Worker name is required";
      createWorkerError.classList.remove("hidden");
    }
    return;
  }

  if (createWorkerError) createWorkerError.classList.add("hidden");
  if (createWorkerSubmit) { createWorkerSubmit.disabled = true; createWorkerSubmit.textContent = "Creating..."; }

  try {
    const resp = await fetch("/api/workers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, project, name, tool, prompt }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (createWorkerError) {
        createWorkerError.textContent = json.error || "Failed to create worker";
        createWorkerError.classList.remove("hidden");
      }
      return;
    }
    closeCreateWorkerModal();
    playDing(true);
  } catch (err) {
    if (createWorkerError) {
      createWorkerError.textContent = err.message || "Network error";
      createWorkerError.classList.remove("hidden");
    }
  } finally {
    if (createWorkerSubmit) { createWorkerSubmit.disabled = false; createWorkerSubmit.textContent = "Create"; }
  }
}

if (createWorkerClose) createWorkerClose.addEventListener("click", closeCreateWorkerModal);
if (createWorkerCancel) createWorkerCancel.addEventListener("click", closeCreateWorkerModal);
if (createWorkerBackdrop) createWorkerBackdrop.addEventListener("click", closeCreateWorkerModal);
if (createWorkerSubmit) createWorkerSubmit.addEventListener("click", submitCreateWorker);
if (createWorkerName) {
  createWorkerName.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeCreateWorkerModal(); }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && createWorkerModal && !createWorkerModal.classList.contains("hidden")) {
    e.preventDefault();
    closeCreateWorkerModal();
  }
});

// --- Pane zoom/focus functionality ---
let zoomedPaneKey = null;
let zoomedPaneOverlayEl = null;

function setFocusedPane(target, label) {
  focusedPaneTarget = target || null;
  focusedPaneLabel = label || "";
  if (voicePaneTargetEl) {
    voicePaneTargetEl.textContent = target ? ("Focused: " + label) : "No pane focused";
    voicePaneTargetEl.classList.toggle("has-target", !!target);
  }
}

function zoomPane(key) {
  const entry = panelMap.get(key);
  if (!entry) return;

  // Unzoom any previously zoomed pane
  unzoomPane();

  zoomedPaneKey = key;
  entry.panel.classList.add("pane-zoomed");
  entry.panel.classList.remove("collapsed");

  // Create a close/minimize button overlay
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-zoom-close";
  closeBtn.textContent = "Minimize";
  closeBtn.title = "Return to tiled view";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    unzoomPane();
  });
  entry.panel.appendChild(closeBtn);
  zoomedPaneOverlayEl = closeBtn;

  // Set as focused pane for voice input
  setFocusedPane(entry.target, entry.projectName + " / " + key.split("\t")[1]);

  // Open the interact overlay automatically
  openPaneInteract(entry, entry.projectName + " / " + (entry.target || ""));

  // Scroll content to bottom
  entry.pre.scrollTop = entry.pre.scrollHeight;
}

function unzoomPane() {
  if (!zoomedPaneKey) return;
  const entry = panelMap.get(zoomedPaneKey);
  if (entry) {
    entry.panel.classList.remove("pane-zoomed");
  }
  if (zoomedPaneOverlayEl) {
    zoomedPaneOverlayEl.remove();
    zoomedPaneOverlayEl = null;
  }
  zoomedPaneKey = null;
  setFocusedPane(null, "");
}

// --- Pane idle/activity detection ---
const paneLastChangeAt = new Map(); // key -> timestamp

function updatePaneActivity(key) {
  paneLastChangeAt.set(key, Date.now());
}

function renderPaneActivityStates() {
  const now = Date.now();
  const IDLE_THRESHOLD_MS = 30000; // 30 seconds
  for (const [key, entry] of panelMap) {
    const lastChange = paneLastChangeAt.get(key) || 0;
    const idle = (now - lastChange) > IDLE_THRESHOLD_MS;
    entry.panel.classList.toggle("pane-idle", idle);
  }
}

// Periodically update idle indicators
setInterval(renderPaneActivityStates, 5000);

// Activate projects tab on load
sendProjectsTabState(true);
