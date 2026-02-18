/**
 * Shared test configuration — token discovery and base URL.
 *
 * Token resolution order:
 *   1. VOICE_TOKEN env var
 *   2. TEST_TOKEN env var
 *   3. Parse from /tmp/voice-url.txt
 *   4. Read from voice server process /proc/<pid>/environ
 */
const fs = require("fs");
const { execSync } = require("child_process");

function discoverToken() {
  if (process.env.VOICE_TOKEN) return process.env.VOICE_TOKEN;
  if (process.env.TEST_TOKEN) return process.env.TEST_TOKEN;

  // Try /tmp/voice-url.txt (written by launch-squad.sh)
  try {
    const raw = fs.readFileSync("/tmp/voice-url.txt", "utf8").trim();
    // URL may be cloudflare or localhost — just extract token param
    const match = raw.match(/[?&]token=([^&\s]+)/);
    if (match) return match[1];
  } catch {}

  // Try reading from shared volume (voice-server writes .voice-token on boot)
  try {
    const token = fs.readFileSync("/home/ubuntu/.voice-token", "utf8").trim();
    if (token) return token;
  } catch {}

  return null;
}

const BASE_URL = process.env.TEST_BASE_URL || "http://voice-server:3000";
const TOKEN = discoverToken();

function pageUrl(token) {
  return `${BASE_URL}?token=${encodeURIComponent(token || TOKEN)}`;
}

function apiUrl(path) {
  return `${BASE_URL}${path}`;
}

module.exports = { BASE_URL, TOKEN, pageUrl, apiUrl, discoverToken };
