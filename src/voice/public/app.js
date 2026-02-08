if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const terminalEl = document.getElementById("terminal");
const summaryEl = document.getElementById("summary");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");

let ws = null;
let mediaRecorder = null;
let recording = false;
let audioChunks = [];
let autoScroll = true;

const urlParams = new URLSearchParams(location.search);
const token = urlParams.get("token") || "";

// Track whether user has scrolled up in the terminal
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
    if (evt.data instanceof ArrayBuffer) {
      audioChunks.push(evt.data);
      return;
    }

    const msg = JSON.parse(evt.data);

    switch (msg.type) {
      case "connected":
        statusEl.textContent = msg.captain;
        statusEl.className = "connected";
        break;

      case "tmux_snapshot":
        terminalEl.textContent = msg.content;
        if (autoScroll) {
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }
        break;

      case "captain_done":
        if (msg.summary) {
          summaryEl.textContent = msg.summary;
        }
        break;

      case "audio_summary_start":
        audioChunks = [];
        break;

      case "audio_summary_end":
        playAudio(audioChunks);
        audioChunks = [];
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

function playAudio(chunks) {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => {});
  audio.onended = () => URL.revokeObjectURL(url);
}

// Text command
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text_command", text }));
  textInput.value = "";
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});

// Mic recording
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/mp4";

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    const recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (ws.readyState !== WebSocket.OPEN || recordedChunks.length === 0) return;

      ws.send(JSON.stringify({ type: "audio_start", mimeType }));
      for (const chunk of recordedChunks) {
        const buf = await chunk.arrayBuffer();
        ws.send(buf);
      }
      ws.send(JSON.stringify({ type: "audio_end" }));
    };

    mediaRecorder.start(250);
    recording = true;
    micBtn.classList.add("recording");
  } catch (err) {
    summaryEl.textContent = "Mic access denied: " + err.message;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recording = false;
  micBtn.classList.remove("recording");
}

micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("mouseleave", () => {
  if (recording) stopRecording();
});

micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});
micBtn.addEventListener("touchcancel", () => {
  if (recording) stopRecording();
});

connect();
