const { defineConfig } = require("@playwright/test");

// Tests that only use stubbed WebSockets / DOM — no tmux or mutating APIs.
// Safe to run in parallel with multiple workers.
const PARALLEL_TESTS = [
  "screenshots.spec.js",
  "autolisten.spec.js",
  "autoread.spec.js",
  "tts-queue.spec.js",
  "tts-e2e.spec.js",
  "websocket.spec.js",
  "switch-account.spec.js",
];

module.exports = defineConfig({
  testDir: ".",
  timeout: 60000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["json", { outputFile: "test-results.json" }]] : "list",
  use: {
    headless: true,
    permissions: ["microphone"],
  },
  projects: [
    {
      name: "parallel",
      testMatch: PARALLEL_TESTS,
      fullyParallel: true,
    },
    {
      name: "serial",
      testIgnore: PARALLEL_TESTS,
      // These tests share tmux sessions and voice-server state —
      // must run one at a time to avoid interleaving.
      fullyParallel: false,
      workers: 1,
    },
  ],
});
