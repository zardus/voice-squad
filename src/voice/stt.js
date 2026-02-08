const https = require("https");

/**
 * Transcribe audio using OpenAI Whisper API.
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} mimeType - e.g. "audio/webm;codecs=opus" or "audio/mp4"
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, mimeType) {
  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  const boundary = "----VoiceBoundary" + Date.now();

  const fileField = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ].join("");

  const modelField = [
    `\r\n--${boundary}\r\n`,
    `Content-Disposition: form-data; name="model"\r\n\r\n`,
    `whisper-1`,
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
    req.end(body);
  });
}

module.exports = { transcribe };
