const https = require("https");

const SHORT_THRESHOLD = 200;

/**
 * Summarize captain output into a voice-friendly 1-3 sentence summary.
 * If previousSummary is provided, focuses on what's new since then.
 * @param {string} rawOutput - Raw captain terminal output
 * @param {string} [previousSummary] - The last summary spoken to the user
 * @returns {Promise<string>} Voice-friendly summary
 */
async function summarize(rawOutput, previousSummary) {
  const trimmed = rawOutput.trim();
  if (!trimmed) return "Nothing happened yet.";
  if (trimmed.length < SHORT_THRESHOLD && !previousSummary) return trimmed;

  let system = `Summarize this terminal output as a voice status update. Be direct and concise — state what is happening, skip conversational filler. No greetings, no "it looks like", no markdown. Just the facts. Can be multiple sentences if needed, but every word should carry information.`;

  if (previousSummary) {
    system += `\n\nIMPORTANT: You already told them the following in your last update: "${previousSummary}". Do NOT repeat any of this information. ONLY say what has changed since then. If nothing meaningful has changed, respond with exactly: "No changes." — nothing else. Be extremely strict about not repeating yourself.`;
  }

  const body = JSON.stringify({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    system,
    messages: [
      {
        role: "user",
        content: trimmed,
      },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            console.error(`Claude API ${res.statusCode}: ${text}`);
            resolve(trimmed.slice(0, 200) + "...");
            return;
          }
          try {
            const data = JSON.parse(text);
            const summary = data.content[0].text;
            resolve(summary);
          } catch (e) {
            resolve(trimmed.slice(0, 200) + "...");
          }
        });
      }
    );
    req.on("error", (err) => {
      console.error("Claude API error:", err.message);
      resolve(trimmed.slice(0, 200) + "...");
    });
    req.end(body);
  });
}

module.exports = { summarize };
