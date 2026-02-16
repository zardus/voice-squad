const https = require("https");
const OPENAI_STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 10 * 60 * 1000);
const OPENAI_STT_MAX_AUDIO_BYTES = Number(process.env.STT_MAX_AUDIO_BYTES || 24 * 1024 * 1024);

/**
 * Detect audio format from file magic bytes, ignoring what the client claims.
 */
function detectFormat(buf) {
  if (buf.length < 12) return { ext: "wav", mime: "audio/wav" };

  // WebM/MKV: EBML header
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { ext: "webm", mime: "audio/webm" };
  }
  // OGG: "OggS"
  if (buf.slice(0, 4).toString() === "OggS") {
    return { ext: "ogg", mime: "audio/ogg" };
  }
  // RIFF/WAV: "RIFF"
  if (buf.slice(0, 4).toString() === "RIFF") {
    return { ext: "wav", mime: "audio/wav" };
  }
  // FLAC: "fLaC"
  if (buf.slice(0, 4).toString() === "fLaC") {
    return { ext: "flac", mime: "audio/flac" };
  }
  // MP3: ID3 tag or sync word
  if (buf.slice(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }
  // MP4/M4A: "ftyp" at offset 4
  if (buf.slice(4, 8).toString() === "ftyp") {
    return { ext: "m4a", mime: "audio/mp4" };
  }
  // CAF (Apple): "caff"
  if (buf.slice(0, 4).toString() === "caff") {
    return { ext: "m4a", mime: "audio/mp4" };
  }

  // Fallback: try m4a since iOS Safari often produces unlabeled mp4
  return { ext: "m4a", mime: "audio/mp4" };
}

/**
 * Transcribe audio using OpenAI Whisper API.
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} mimeType - reported by client (used as fallback only)
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, mimeType) {
  if (audioBuffer.length < 1000) {
    throw new Error(`Audio too short (${audioBuffer.length} bytes), skipping`);
  }
  if (audioBuffer.length > OPENAI_STT_MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio too large for transcription (${audioBuffer.length} bytes). Max is ${OPENAI_STT_MAX_AUDIO_BYTES} bytes.`
    );
  }

  const detected = detectFormat(audioBuffer);
  console.log(`[stt] ${audioBuffer.length} bytes, client says: ${mimeType}, detected: ${detected.ext} (${detected.mime})`);

  const boundary = "----VoiceBoundary" + Date.now();

  const fileField = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="audio.${detected.ext}"\r\n`,
    `Content-Type: ${detected.mime}\r\n\r\n`,
  ].join("");

  const modelField = [
    `\r\n--${boundary}\r\n`,
    `Content-Disposition: form-data; name="model"\r\n\r\n`,
    `gpt-4o-mini-transcribe`,
  ].join("");

  const tail = `\r\n--${boundary}--\r\n`;

  const bodyParts = [
    Buffer.from(fileField),
    audioBuffer,
    Buffer.from(modelField),
    Buffer.from(tail),
  ];
  const body = Buffer.concat(bodyParts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`Whisper API ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text).text);
          } catch (e) {
            reject(new Error(`Failed to parse Whisper response: ${text}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(OPENAI_STT_TIMEOUT_MS, () => {
      req.destroy(new Error(`Whisper request timed out after ${OPENAI_STT_TIMEOUT_MS}ms`));
    });
    req.end(body);
  });
}

module.exports = { transcribe };
