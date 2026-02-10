const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadStripInputBox(modulePath) {
  const abs = path.resolve(modulePath);
  const code = fs.readFileSync(abs, "utf8") + "\nmodule.exports.__stripInputBox = stripInputBox;\n";

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require,
    __filename: abs,
    __dirname: path.dirname(abs),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(code, sandbox, { filename: abs });
  assert.strictEqual(typeof mod.exports.__stripInputBox, "function", `${modulePath}: stripInputBox not found`);
  return mod.exports.__stripInputBox;
}

function runTests(stripInputBox, label) {
  // Claude-style delimiter UI (already supported): cut at second-to-last delimiter.
  const claude = [
    "Some conversation output here...",
    "────────────────────────────────────────────────────────",
    "❯ some autosuggest text",
    "────────────────────────────────────────────────────────",
    "",
  ].join("\n");
  assert.strictEqual(stripInputBox(claude), "Some conversation output here...", `${label}: Claude strip failed`);

  // Codex-style UI: blank padding + prompt "›" + status lines near bottom.
  const codex = [
    "Some conversation output here...",
    "Agent made changes to files.",
    "",
    "",
    "› Explain this codebase",
    "",
    "  ? for shortcuts                                    85% context left",
    "",
  ].join("\n");
  assert.strictEqual(
    stripInputBox(codex),
    "Some conversation output here...\nAgent made changes to files.",
    `${label}: Codex strip failed`,
  );

  // Plain output: no UI chrome should pass through (modulo trimEnd behavior).
  const plain = "Hello\nWorld\n";
  assert.strictEqual(stripInputBox(plain), "Hello\nWorld", `${label}: plain pass-through failed`);
}

const bridgeStrip = loadStripInputBox("/opt/squad/voice/tmux-bridge.js");
const statusStrip = loadStripInputBox("/opt/squad/voice/status-daemon.js");

runTests(bridgeStrip, "tmux-bridge");
runTests(statusStrip, "status-daemon");

console.log("OK");

