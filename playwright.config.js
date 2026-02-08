const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60000,
  retries: 0,
  use: {
    headless: true,
    // Grant mic permission so MediaRecorder tests work
    permissions: ["microphone"],
  },
});
