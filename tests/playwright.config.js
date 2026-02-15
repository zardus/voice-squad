const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  timeout: 60000,
  retries: 0,
  // The suite shares one tmux "captain" session + one voice server; parallel workers
  // can interleave tmux input and cause flakes.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["json", { outputFile: "test-results.json" }]] : "list",
  use: {
    headless: true,
    permissions: ["microphone"],
  },
});
