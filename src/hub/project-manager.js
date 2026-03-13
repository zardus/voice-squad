const { execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const PROJECTS_SOCKETS_DIR =
  process.env.PROJECTS_SOCKETS_DIR || "/run/squad/tmux/projects";

// Auto-detect host path for /home/ubuntu by inspecting our own container's mounts.
function detectHostHomePath() {
  try {
    // Get our container ID from /proc/self/cgroup or hostname
    const hostname = fs.readFileSync("/etc/hostname", "utf8").trim();
    const inspect = require("child_process").execFileSync(
      "docker",
      ["inspect", hostname, "--format", "{{json .Mounts}}"],
      { encoding: "utf8", timeout: 5000 }
    );
    const mounts = JSON.parse(inspect);
    const homeMount = mounts.find((m) => m.Destination === "/home/ubuntu");
    if (homeMount && homeMount.Source) return homeMount.Source;
  } catch {}
  return "";
}

const HOST_HOME_PATH = process.env.HOST_HOME_PATH || detectHostHomePath();
const SQUAD_WORKSPACE_IMAGE = process.env.SQUAD_WORKSPACE_IMAGE || "";
const SQUAD_DOCKER_NETWORK = process.env.SQUAD_DOCKER_NETWORK || "";
const SQUAD_SHARED_VOLUME = process.env.SQUAD_SHARED_VOLUME || "";
const HOME_DIR = process.env.HOME || "/home/ubuntu";

function validateProjectName(name) {
  if (!name || typeof name !== "string")
    throw new Error("Project name is required");
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new Error(
      "Invalid project name. Use alphanumeric characters, dots, hyphens, and underscores."
    );
  }
  if (trimmed.length > 64)
    throw new Error("Project name too long (max 64 characters)");
  return trimmed;
}

function dockerExec(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || "").trim() || err.message));
        else resolve((stdout || "").trim());
      }
    );
  });
}

function tmuxHasSession(socketPath) {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["-S", socketPath, "has-session", "-t", "agents"],
      { timeout: 5000 },
      (err) => resolve(!err)
    );
  });
}

async function listProjects() {
  const projects = [];
  try {
    const entries = fs.readdirSync(PROJECTS_SOCKETS_DIR, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const socketPath = path.join(
        PROJECTS_SOCKETS_DIR,
        entry.name,
        "default"
      );
      let hasSocket = false;
      try {
        hasSocket = fs.statSync(socketPath).isSocket();
      } catch {}
      const hasSession = hasSocket ? await tmuxHasSession(socketPath) : false;
      projects.push({
        name: entry.name,
        status: hasSession ? "running" : "starting",
      });
    }
  } catch {}

  // Also check Docker for containers that may not have sockets yet (starting up)
  try {
    const output = await dockerExec([
      "ps",
      "-a",
      "--filter",
      "name=squad-project-",
      "--format",
      "{{.Names}}\t{{.State}}",
    ]);
    if (output) {
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const [rawName, state] = line.split("\t");
        const projectName = rawName.replace(/^squad-project-/, "");
        const existing = projects.find((p) => p.name === projectName);
        if (existing) {
          if (state !== "running") existing.status = state || "unknown";
        } else {
          projects.push({ name: projectName, status: state || "stopped" });
        }
      }
    }
  } catch {}

  return projects;
}

async function createProject(name) {
  name = validateProjectName(name);

  if (!HOST_HOME_PATH) throw new Error("HOST_HOME_PATH not configured");
  if (!SQUAD_WORKSPACE_IMAGE)
    throw new Error("SQUAD_WORKSPACE_IMAGE not configured");
  if (!SQUAD_DOCKER_NETWORK)
    throw new Error("SQUAD_DOCKER_NETWORK not configured");
  if (!SQUAD_SHARED_VOLUME)
    throw new Error("SQUAD_SHARED_VOLUME not configured");

  const containerName = `squad-project-${name}`;
  const projectDir = path.join(HOME_DIR, "projects", name);
  const socketPath = path.join(PROJECTS_SOCKETS_DIR, name, "default");

  // Check if already running
  try {
    const running = await dockerExec([
      "ps",
      "--format",
      "{{.Names}}",
      "--filter",
      `name=^${containerName}$`,
    ]);
    if (running.includes(containerName)) {
      throw new Error(`Project '${name}' is already running`);
    }
  } catch (err) {
    if (err.message.includes("already running")) throw err;
  }

  // Remove any stopped container
  await dockerExec(["rm", "-f", containerName]).catch(() => {});

  // Create project directory
  await fsp.mkdir(projectDir, { recursive: true });

  // Build docker run arguments
  const dockerArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    SQUAD_DOCKER_NETWORK,
    "-e",
    `PROJECT_NAME=${name}`,
    "-e",
    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
    "-e",
    `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ""}`,
    "-e",
    `GH_TOKEN=${process.env.GH_TOKEN || ""}`,
    "-v",
    `${HOST_HOME_PATH}/projects/${name}:/home/ubuntu`,
    "-v",
    `${HOST_HOME_PATH}/overseer:/home/ubuntu/overseer:ro`,
    "-v",
    `${SQUAD_SHARED_VOLUME}:/run/squad`,
  ];

  // Mount env file if it exists
  const envPath = path.join(HOME_DIR, "env");
  if (fs.existsSync(envPath)) {
    dockerArgs.push("-v", `${HOST_HOME_PATH}/env:/home/ubuntu/env:ro`);
  }

  dockerArgs.push(SQUAD_WORKSPACE_IMAGE);

  await dockerExec(dockerArgs);

  // Wait up to 60s for tmux session
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await tmuxHasSession(socketPath)) {
      return { name, status: "running" };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `Project '${name}' container started but tmux session not available after 60s`
  );
}

async function deleteProject(name) {
  name = validateProjectName(name);

  const containerName = `squad-project-${name}`;
  const socketDir = path.join(PROJECTS_SOCKETS_DIR, name);

  await dockerExec(["stop", containerName]).catch(() => {});
  await dockerExec(["rm", containerName]).catch(() => {});

  try {
    await fsp.rm(socketDir, { recursive: true, force: true });
  } catch {}

  return { name, status: "stopped" };
}

module.exports = { listProjects, createProject, deleteProject };
