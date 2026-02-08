// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const output = document.getElementById("output");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");

let ws = null;
let mediaRecorder = null;
let recording = false;
let audioContext = null;

// Carry the token from the URL into the WebSocket connection
const urlParams = new URLSearchParams(location.search);
const token = urlParams.get("token") || "";

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
      handleAudioData(evt.data);
      return;
    }

    const msg = JSON.parse(evt.data);

    switch (msg.type) {
      case "connected":
        statusEl.textContent = msg.captain;
        statusEl.className = "connected";
        addMessage("system", `Connected to ${msg.captain} captain`);
        break;

      case "transcription":
        addMessage("user", msg.text);
        break;

      case "captain_output":
        updateCaptainOutput(msg.text);
        break;

      case "captain_done":
        finalizeCaptainOutput(msg.fullOutput);
        if (msg.summary) {
          addMessage("summary", msg.summary);
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
        addMessage("error", msg.message);
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

let audioChunks = [];

function handleAudioData(buffer) {
  audioChunks.push(buffer);
}

function playAudio(chunks) {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => {});
  audio.onended = () => URL.revokeObjectURL(url);
}

let currentCaptainMsg = null;

function updateCaptainOutput(text) {
  if (!currentCaptainMsg) {
    currentCaptainMsg = document.createElement("div");
    currentCaptainMsg.className = "msg captain";
    output.appendChild(currentCaptainMsg);
  }
  currentCaptainMsg.textContent = text;
  output.scrollTop = output.scrollHeight;
}

function finalizeCaptainOutput(text) {
  if (currentCaptainMsg) {
    currentCaptainMsg.textContent = text;
  }
  currentCaptainMsg = null;
  output.scrollTop = output.scrollHeight;
}

function addMessage(type, text) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

// Text command
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addMessage("user", text);
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

    // Pick a supported mimeType
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/mp4";

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    ws.send(JSON.stringify({ type: "audio_start", mimeType }));

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then((buf) => ws.send(buf));
      }
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_end" }));
      }
    };

    mediaRecorder.start(250); // chunk every 250ms
    recording = true;
    micBtn.classList.add("recording");
  } catch (err) {
    addMessage("error", "Mic access denied: " + err.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recording = false;
  micBtn.classList.remove("recording");
}

// Hold-to-talk for mic button
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
