const https = require("https");

/**
 * Convert text to speech using OpenAI TTS API.
 * @param {string} text - Text to speak
 * @param {string} [format] - OpenAI response format: "opus" (default), "mp3", or "aac"
 * @returns {Promise<{ audio: Buffer, format: string, mime: string }>}
 */
async function synthesize(text, format = "opus") {
  const safeFormat = typeof format === "string" ? format.toLowerCase() : "opus";
  const response_format = (safeFormat === "mp3" || safeFormat === "aac" || safeFormat === "opus")
    ? safeFormat
    : "opus";

  const mime = response_format === "mp3"
    ? "audio/mpeg"
    : response_format === "aac"
      ? "audio/aac"
      : "audio/ogg";

  const body = JSON.stringify({
    model: "tts-1",
    input: text,
    voice: "alloy",
    response_format,
    speed: 1.15,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/audio/speech",
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `TTS API ${res.statusCode}: ${Buffer.concat(chunks).toString()}`
              )
            );
            return;
          }
          resolve({ audio: Buffer.concat(chunks), format: response_format, mime });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

module.exports = { synthesize };
