const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const PROJECTS_SOCKETS_DIR =
  process.env.PROJECTS_SOCKETS_DIR || "/run/squad-sockets/projects";
const HOME_DIR = process.env.HOME || "/home/ubuntu";
const TASKS_DIR = path.join(HOME_DIR, "tasks");
const TASKS_PENDING_DIR = path.join(TASKS_DIR, "pending");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxExec(socketPath, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-S", socketPath, ...args];
    execFile(
      "tmux",
      fullArgs,
      { encoding: "utf8", timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error((stderr || "").trim() || err.message)
          );
        else resolve((stdout || "").trim());
      }
    );
  });
}

function getSocketPath(projectName) {
  return path.join(PROJECTS_SOCKETS_DIR, projectName, "default");
}

function validateName(name, label) {
  if (!name || typeof name !== "string")
    throw new Error(`${label} is required`);
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed))
    throw new Error(
      `Invalid ${label}. Use alphanumeric characters, dots, hyphens, and underscores.`
    );
  if (trimmed.length > 64)
    throw new Error(`${label} too long (max 64 characters)`);
  return trimmed;
}

function validateTool(tool) {
  if (tool !== "claude" && tool !== "codex")
    throw new Error(`Tool must be 'claude' or 'codex' (got '${tool}')`);
  return tool;
}

/**
 * Check that a project socket exists and the agents session is alive.
 * Returns the socket path.
 */
async function ensureProjectReady(projectName) {
  const socketPath = getSocketPath(projectName);

  let hasSocket = false;
  try {
    hasSocket = fs.statSync(socketPath).isSocket();
  } catch {}
  if (!hasSocket) {
    throw new Error(
      `Project '${projectName}' socket not found at ${socketPath}. Is the project container running?`
    );
  }

  try {
    await tmuxExec(socketPath, ["has-session", "-t", "agents"]);
  } catch {
    throw new Error(
      `No 'agents' tmux session found for project '${projectName}'. The container may still be starting.`
    );
  }

  return socketPath;
}

/**
 * List tmux windows in a project's agents session.
 * Returns an array of { name, index }.
 */
async function listWindowsInProject(socketPath) {
  let raw;
  try {
    raw = await tmuxExec(socketPath, [
      "list-windows",
      "-t",
      "agents",
      "-F",
      "#{window_name}\t#{window_index}",
    ]);
  } catch {
    return [];
  }
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, index] = line.split("\t");
      return { name, index };
    });
}

// ---------------------------------------------------------------------------
// createWorker
// ---------------------------------------------------------------------------

/**
 * Create a worker as a tmux window in a project's agents session.
 *
 * @param {string} projectName - Name of the project container
 * @param {string} workerName  - Name for the worker (tmux window name)
 * @param {string} tool        - "claude" or "codex"
 * @param {string} taskPrompt  - The task prompt to pass to the agent
 * @param {Object} [envVars]   - Optional extra environment variables (key-value pairs)
 * @returns {Promise<{project: string, worker: string, tool: string}>}
 */
async function createWorker(projectName, workerName, tool, taskPrompt, envVars) {
  projectName = validateName(projectName, "Project name");
  workerName = validateName(workerName, "Worker name");
  tool = validateTool(tool);

  if (!taskPrompt || typeof taskPrompt !== "string" || !taskPrompt.trim()) {
    throw new Error("Task prompt is required");
  }

  const socketPath = await ensureProjectReady(projectName);

  // Check that a window with this name doesn't already exist
  const existingWindows = await listWindowsInProject(socketPath);
  if (existingWindows.some((w) => w.name === workerName)) {
    throw new Error(
      `Worker '${workerName}' already exists in project '${projectName}'`
    );
  }

  // Write task file for archival purposes
  await fsp.mkdir(TASKS_PENDING_DIR, { recursive: true });
  const taskFilePath = path.join(TASKS_PENDING_DIR, `${workerName}.task`);
  await fsp.writeFile(taskFilePath, taskPrompt, "utf8");

  // Build the worker command.
  // Escape single quotes in the task prompt for safe embedding in shell.
  const escapedPrompt = taskPrompt.replace(/'/g, "'\\''");

  let workerCmd;
  if (tool === "claude") {
    workerCmd = `claude --dangerously-skip-permissions '${escapedPrompt}'`;
  } else {
    workerCmd = `codex --dangerously-bypass-approvals-and-sandbox '${escapedPrompt}'`;
  }

  // Source env file, then run the worker command
  const fullCmd =
    "{ [ -f /home/ubuntu/env ] && set -a && . /home/ubuntu/env && set +a || true; } && " +
    workerCmd;

  // Build tmux new-window args with optional env flags
  const newWindowArgs = ["new-window"];

  // Pass extra environment variables via -e flags
  if (envVars && typeof envVars === "object") {
    for (const [key, value] of Object.entries(envVars)) {
      if (key && typeof value === "string") {
        newWindowArgs.push("-e", `${key}=${value}`);
      }
    }
  }

  newWindowArgs.push("-t", "agents", "-n", workerName, "-c", "/home/ubuntu");

  // Create the new tmux window
  await tmuxExec(socketPath, newWindowArgs);
  await sleep(500);

  // Send the startup command (text first, then Enter separately for reliability)
  await tmuxExec(socketPath, [
    "send-keys",
    "-t",
    `agents:${workerName}`,
    fullCmd,
  ]);
  await sleep(1000);
  await tmuxExec(socketPath, [
    "send-keys",
    "-t",
    `agents:${workerName}`,
    "Enter",
  ]);

  // Auto-accept Claude trust/setup dialogs
  if (tool === "claude") {
    console.log(
      `[worker-manager] Handling Claude dialogs for ${projectName}/${workerName}...`
    );
    const target = `agents:${workerName}`;

    for (let i = 0; i < 15; i++) {
      await sleep(2000);

      let paneText = "";
      try {
        const raw = await tmuxExec(socketPath, [
          "capture-pane",
          "-t",
          target,
          "-p",
          "-S",
          "-30",
        ]);
        // Strip ANSI escape sequences
        paneText = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      } catch {
        continue;
      }

      // Setup dialogs (text style, getting started)
      if (
        paneText.includes("Choose the text style") ||
        paneText.includes("Let's get started")
      ) {
        console.log(
          `[worker-manager] Handling setup dialog for ${projectName}/${workerName}`
        );
        await tmuxExec(socketPath, ["send-keys", "-t", target, "Enter"]);
        continue;
      }

      // Trust dialog: "Yes, I accept" + optionally "Enter to confirm"
      if (paneText.includes("Yes, I accept")) {
        // Check if claude exited at trust prompt (no child process)
        let shellPid = "";
        try {
          shellPid = await tmuxExec(socketPath, [
            "list-panes",
            "-t",
            target,
            "-F",
            "#{pane_pid}",
          ]);
        } catch {}

        let childPid = "";
        if (shellPid) {
          try {
            childPid = execFileSync(
              "ps",
              ["-o", "pid=", "--ppid", shellPid.split("\n")[0].trim()],
              { encoding: "utf8", timeout: 3000 }
            )
              .trim()
              .split("\n")[0]
              .trim();
          } catch {}
        }

        if (!childPid) {
          // Claude exited at trust prompt — accept and restart
          console.log(
            `[worker-manager] Claude exited at trust prompt for ${projectName}/${workerName}, restarting...`
          );
          await tmuxExec(socketPath, ["send-keys", "-t", target, "Enter"]);
          await sleep(1000);
          await tmuxExec(socketPath, [
            "send-keys",
            "-t",
            target,
            `unset TMUX && ${fullCmd}`,
          ]);
          await sleep(500);
          await tmuxExec(socketPath, ["send-keys", "-t", target, "Enter"]);
          continue;
        }

        if (paneText.includes("Enter to confirm")) {
          console.log(
            `[worker-manager] Accepting trust dialog for ${projectName}/${workerName}`
          );
          await tmuxExec(socketPath, ["send-keys", "-t", target, "2"]);
          await sleep(500);
          await tmuxExec(socketPath, ["send-keys", "-t", target, "Enter"]);
          await sleep(2000);
          continue;
        }
      }

      // Other "Enter to confirm" dialogs
      if (paneText.includes("Enter to confirm")) {
        console.log(
          `[worker-manager] Accepting dialog for ${projectName}/${workerName}`
        );
        await tmuxExec(socketPath, ["send-keys", "-t", target, "Enter"]);
        continue;
      }

      // Check if the agent process is actually running and past dialogs
      try {
        const panePid = await tmuxExec(socketPath, [
          "list-panes",
          "-t",
          target,
          "-F",
          "#{pane_pid}",
        ]);
        if (panePid) {
          let child = "";
          try {
            child = execFileSync(
              "ps",
              ["-o", "pid=", "--ppid", panePid.split("\n")[0].trim()],
              { encoding: "utf8", timeout: 3000 }
            ).trim();
          } catch {}

          if (child && !paneText.includes("Enter to confirm")) {
            console.log(
              `[worker-manager] Agent running for ${projectName}/${workerName}`
            );
            break;
          }
        }
      } catch {}
    }
  } else {
    // Codex: brief wait for startup
    await sleep(3000);
  }

  return { project: projectName, worker: workerName, tool };
}

// ---------------------------------------------------------------------------
// listWorkers
// ---------------------------------------------------------------------------

/**
 * List active workers across all projects.
 * Returns an array of { project, worker, tool } objects.
 */
async function listWorkers() {
  const workers = [];

  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_SOCKETS_DIR, { withFileTypes: true });
  } catch {
    return workers;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const socketPath = path.join(PROJECTS_SOCKETS_DIR, entry.name, "default");
    let hasSocket = false;
    try {
      hasSocket = fs.statSync(socketPath).isSocket();
    } catch {}
    if (!hasSocket) continue;

    const windows = await listWindowsInProject(socketPath);

    for (const win of windows) {
      if (win.name === "PLACEHOLDER") continue;

      // Check what process is running in the pane
      let paneCmd = "";
      try {
        paneCmd = await tmuxExec(socketPath, [
          "list-panes",
          "-t",
          `agents:${win.index}`,
          "-F",
          "#{pane_current_command}",
        ]);
        paneCmd = paneCmd.split("\n")[0].trim();
      } catch {}

      // Only include windows running a known agent process
      if (["claude", "codex", "node", "npm"].includes(paneCmd)) {
        workers.push({
          project: entry.name,
          worker: win.name,
          tool: paneCmd,
        });
      }
    }
  }

  return workers;
}

// ---------------------------------------------------------------------------
// killWorker
// ---------------------------------------------------------------------------

/**
 * Kill a worker tmux window.
 *
 * @param {string} projectName - Name of the project
 * @param {string} workerName  - Name of the worker window to kill
 * @returns {Promise<{project: string, worker: string, status: string}>}
 */
async function killWorker(projectName, workerName) {
  projectName = validateName(projectName, "Project name");
  workerName = validateName(workerName, "Worker name");

  const socketPath = await ensureProjectReady(projectName);

  // Verify the window exists
  const windows = await listWindowsInProject(socketPath);
  if (!windows.some((w) => w.name === workerName)) {
    throw new Error(
      `Worker '${workerName}' not found in project '${projectName}'`
    );
  }

  // Kill the tmux window
  await tmuxExec(socketPath, [
    "kill-window",
    "-t",
    `agents:${workerName}`,
  ]);

  return { project: projectName, worker: workerName, status: "killed" };
}

module.exports = { createWorker, listWorkers, killWorker };
