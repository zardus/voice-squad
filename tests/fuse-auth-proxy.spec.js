// @ts-check
/**
 * FUSE auth proxy tests — verify PID-based credential routing.
 *
 * The FUSE auth proxy mounts over ~/.claude/ and ~/.codex/ inside the
 * workspace container. Different PIDs see different credential files
 * based on their registered account.
 *
 * These tests exercise:
 *   1. Control socket: register/unregister/query/list commands
 *   2. PID routing: different PIDs read different credentials
 *   3. Write-back: writes persist to the correct backing file
 *   4. stat(): returns regular-file attributes (not FUSE-specific)
 */
const { test, expect } = require("@playwright/test");
const { TOKEN } = require("./helpers/config");
const { workspaceExec } = require("./helpers/tmux");
const { execSync } = require("child_process");
const fs = require("fs");

const CONTROL_SOCKET =
  process.env.FUSE_AUTH_CONTROL_SOCKET || "/run/fuse-auth-proxy/control.sock";

// Unique suffix per test run to avoid collisions with parallel runs
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Send a JSON command to the FUSE auth proxy control socket and return the response.
 * Uses a temp file for the python script to avoid shell quoting issues.
 */
function sendControlCmd(cmd) {
  const json = JSON.stringify(cmd);
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pyFile = `/tmp/fuse-ctl-${id}.py`;
  const pyScript = `
import socket, json, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(${JSON.stringify(CONTROL_SOCKET)})
s.sendall(json.dumps(${JSON.stringify(cmd)}).encode() + b"\\n")
s.shutdown(socket.SHUT_WR)
data = b""
while True:
    chunk = s.recv(4096)
    if not chunk: break
    data += chunk
s.close()
print(data.decode().strip())
`;
  fs.writeFileSync(pyFile, pyScript);
  try {
    const result = execSync(`python3 ${pyFile}`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return JSON.parse(result.trim());
  } finally {
    try { fs.unlinkSync(pyFile); } catch {}
  }
}

/**
 * Run a command inside the workspace container via tmux and capture output.
 * Uses a file written to the shared /home/ubuntu volume for reliable I/O.
 *
 * @param {string} cmd - Command to run
 * @param {number} timeoutMs - Timeout in ms (default 15s, increase for slow ops)
 */
function workspaceRun(cmd, timeoutMs = 15000) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outFile = `/home/ubuntu/.fuse-test-${id}.out`;
  const doneFile = `/home/ubuntu/.fuse-test-${id}.done`;
  const scriptFile = `/home/ubuntu/.fuse-test-${id}.sh`;

  // Write the script using a heredoc-like approach to avoid quoting issues
  fs.writeFileSync(
    scriptFile,
    `#!/bin/bash\n( ${cmd} ) > ${outFile} 2>&1\necho \\$? > ${doneFile}\n`,
    { mode: 0o755 }
  );

  // Execute the script via tmux in workspace
  workspaceExec(`send-keys -t workspace:0 "bash ${scriptFile}" Enter`);

  // Wait for the done file to appear
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.accessSync(doneFile);
      // Give a moment for write to flush
      execSync("sleep 0.1");
      const output = fs.readFileSync(outFile, "utf8").trim();
      // Cleanup
      try { fs.unlinkSync(scriptFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      try { fs.unlinkSync(doneFile); } catch {}
      return output;
    } catch {
      // File not yet available
    }
    execSync("sleep 0.3");
  }

  // Cleanup on timeout
  try { fs.unlinkSync(scriptFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(doneFile); } catch {}
  throw new Error(`Timed out waiting for command: ${cmd}`);
}

test.describe("FUSE auth proxy", () => {
  test.beforeAll(async () => {
    if (!TOKEN)
      throw new Error(
        "Cannot discover VOICE_TOKEN — set it or ensure /tmp/voice-url.txt exists"
      );

    // Wait for FUSE auth proxy to be ready (30s timeout, polling every 500ms)
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        fs.accessSync("/run/fuse-auth-proxy/ready");
        ready = true;
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      throw new Error("FUSE auth proxy not ready after 30s");
    }
  });

  test("control socket is available", () => {
    const resp = sendControlCmd({ cmd: "list" });
    expect(resp.ok).toBe(true);
    expect(resp).toHaveProperty("mappings");
  });

  test("register and query a PID", () => {
    const fakePid = 999999;

    try {
      // Register
      const regResp = sendControlCmd({
        cmd: "register",
        pid: fakePid,
        account: `test-account-alice-${RUN_ID}`,
      });
      expect(regResp.ok).toBe(true);

      // Query
      const queryResp = sendControlCmd({ cmd: "query", pid: fakePid });
      expect(queryResp.ok).toBe(true);
      expect(queryResp.account).toBe(`test-account-alice-${RUN_ID}`);

      // List — should include our PID
      const listResp = sendControlCmd({ cmd: "list" });
      expect(listResp.ok).toBe(true);
      expect(listResp.mappings[String(fakePid)]).toBe(
        `test-account-alice-${RUN_ID}`
      );

      // Unregister
      const unregResp = sendControlCmd({ cmd: "unregister", pid: fakePid });
      expect(unregResp.ok).toBe(true);

      // Query after unregister — should return default account
      const queryAfter = sendControlCmd({ cmd: "query", pid: fakePid });
      expect(queryAfter.ok).toBe(true);
      expect(queryAfter.account).toBe("default");
    } finally {
      // Ensure PID is always unregistered even if assertions fail
      try { sendControlCmd({ cmd: "unregister", pid: fakePid }); } catch {}
    }
  });

  test("cleanup removes stale PIDs", () => {
    // Register a PID that definitely doesn't exist
    const deadPid = 2147483;

    try {
      sendControlCmd({
        cmd: "register",
        pid: deadPid,
        account: `dead-account-${RUN_ID}`,
      });

      // Verify it's registered
      const before = sendControlCmd({ cmd: "list" });
      expect(before.mappings[String(deadPid)]).toBe(
        `dead-account-${RUN_ID}`
      );

      // Cleanup
      const cleanResp = sendControlCmd({ cmd: "cleanup" });
      expect(cleanResp.ok).toBe(true);

      // Verify it's gone
      const after = sendControlCmd({ cmd: "list" });
      expect(after.mappings[String(deadPid)]).toBeUndefined();
    } finally {
      // Ensure cleanup in case test fails before cleanup command
      try { sendControlCmd({ cmd: "unregister", pid: deadPid }); } catch {}
    }
  });

  test("FUSE mount serves different credentials per PID", () => {
    test.setTimeout(60000);

    const profilesDir = "/home/ubuntu/captain/auth/profiles";
    const acctA = `acct-a-${RUN_ID}`;
    const acctB = `acct-b-${RUN_ID}`;
    let shellPid;

    try {
      // Set up two test accounts with different credentials via workspace tmux
      workspaceRun(
        `mkdir -p ${profilesDir}/${acctA}/claude ${profilesDir}/${acctB}/claude`
      );
      workspaceRun(
        `printf '{"account":"alice","token":"alice-token-123"}' > ${profilesDir}/${acctA}/claude/.credentials.json`
      );
      workspaceRun(
        `printf '{"account":"bob","token":"bob-token-456"}' > ${profilesDir}/${acctB}/claude/.credentials.json`
      );

      // Get the shell PID of workspace:0
      shellPid = workspaceExec(
        "list-panes -t workspace:0 -F '#{pane_pid}'"
      ).trim();
      expect(Number(shellPid)).toBeGreaterThan(0);

      // Register the workspace shell PID with account acct-a
      sendControlCmd({
        cmd: "register",
        pid: Number(shellPid),
        account: acctA,
      });

      // Read the credential file from inside workspace — should get alice's creds
      const aliceCreds = workspaceRun("cat ~/.claude/.credentials.json");
      expect(aliceCreds).toContain("alice");

      // Switch to account acct-b
      sendControlCmd({
        cmd: "register",
        pid: Number(shellPid),
        account: acctB,
      });

      // Read again — should get bob's creds
      const bobCreds = workspaceRun("cat ~/.claude/.credentials.json");
      expect(bobCreds).toContain("bob");
    } finally {
      // Always unregister PID and clean up profile dirs
      if (shellPid) {
        try { sendControlCmd({ cmd: "unregister", pid: Number(shellPid) }); } catch {}
      }
      try {
        workspaceRun(`rm -rf ${profilesDir}/${acctA} ${profilesDir}/${acctB}`);
      } catch {}
    }
  });

  test("write-back persists to correct backing file", () => {
    test.setTimeout(60000);

    const profilesDir = "/home/ubuntu/captain/auth/profiles";
    const acct = `write-test-${RUN_ID}`;
    let shellPid;

    try {
      // Create a test account
      workspaceRun(`mkdir -p ${profilesDir}/${acct}/claude`);
      workspaceRun(
        `printf '{"original":true}' > ${profilesDir}/${acct}/claude/.credentials.json`
      );

      // Get workspace shell PID and register
      shellPid = workspaceExec(
        "list-panes -t workspace:0 -F '#{pane_pid}'"
      ).trim();
      sendControlCmd({
        cmd: "register",
        pid: Number(shellPid),
        account: acct,
      });

      // Write through the FUSE mount
      workspaceRun(
        `printf '{"refreshed":true,"token":"new-token"}' > ~/.claude/.credentials.json`
      );

      // Read back through FUSE — should see the new content
      const fuseContent = workspaceRun("cat ~/.claude/.credentials.json");
      expect(fuseContent).toContain("refreshed");
      expect(fuseContent).toContain("new-token");

      // Read directly from the backing file — should also have the new content
      const backingContent = workspaceRun(
        `cat ${profilesDir}/${acct}/claude/.credentials.json`
      );
      expect(backingContent).toContain("refreshed");
      expect(backingContent).toContain("new-token");
    } finally {
      // Always unregister and clean up
      if (shellPid) {
        try { sendControlCmd({ cmd: "unregister", pid: Number(shellPid) }); } catch {}
      }
      try { workspaceRun(`rm -rf ${profilesDir}/${acct}`); } catch {}
    }
  });

  test("stat returns regular-file attributes for registered PID", () => {
    test.setTimeout(30000);

    const profilesDir = "/home/ubuntu/captain/auth/profiles";
    const acct = `stat-test-${RUN_ID}`;
    let shellPid;

    try {
      // Create a test account with a credential file
      workspaceRun(`mkdir -p ${profilesDir}/${acct}/claude`);
      workspaceRun(
        `printf '{"stat":"test"}' > ${profilesDir}/${acct}/claude/.credentials.json`
      );

      // Register the workspace shell PID with the test account
      shellPid = workspaceExec(
        "list-panes -t workspace:0 -F '#{pane_pid}'"
      ).trim();
      sendControlCmd({
        cmd: "register",
        pid: Number(shellPid),
        account: acct,
      });

      // stat the credential file through the FUSE mount — should resolve to
      // the per-account file, not the default
      const statOutput = workspaceRun(
        "stat -c '%F %a' ~/.claude/.credentials.json"
      );
      // Should be a regular file (not FUSE/special), with normal permissions
      expect(statOutput).toMatch(/regular (empty )?file/);

      // Verify the content comes from our registered account's file
      const content = workspaceRun("cat ~/.claude/.credentials.json");
      expect(content).toContain("stat");
    } finally {
      if (shellPid) {
        try { sendControlCmd({ cmd: "unregister", pid: Number(shellPid) }); } catch {}
      }
      try { workspaceRun(`rm -rf ${profilesDir}/${acct}`); } catch {}
    }
  });
});
