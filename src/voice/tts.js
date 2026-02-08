const https = require("https");

/**
 * Convert text to speech using OpenAI TTS API.
 * @param {string} text - Text to speak
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesize(text) {
  const body = JSON.stringify({
    model: "tts-1",
    input: text,
    voice: "alloy",
    response_format: "mp3",
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
          resolve(Buffer.concat(chunks));
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

module.exports = { synthesize };
