/**
 * Shared tmux helpers for tests — wraps socket-aware tmux commands.
 *
 * Uses OVERSEER_TMUX_SOCKET / PROJECTS_SOCKETS_DIR env vars when set.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OVERSEER_SOCKET = process.env.OVERSEER_TMUX_SOCKET || "";
const PROJECTS_SOCKETS_DIR = process.env.PROJECTS_SOCKETS_DIR || "/run/squad-sockets/projects";

function overseerTmuxCmd(args) {
  const socketArgs = OVERSEER_SOCKET ? `-S ${OVERSEER_SOCKET} ` : "";
  return `tmux ${socketArgs}${args}`;
}

function projectTmuxCmd(projectName, args) {
  const socketPath = path.join(PROJECTS_SOCKETS_DIR, projectName, "default");
  return `tmux -S ${socketPath} ${args}`;
}

function overseerExec(args, opts = {}) {
  return execSync(overseerTmuxCmd(args), {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

function projectExec(projectName, args, opts = {}) {
  return execSync(projectTmuxCmd(projectName, args), {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

/**
 * Discover all project sockets currently available.
 * Returns array of { projectName, socketPath }.
 */
function discoverProjectSockets() {
  const sockets = [];
  try {
    const entries = fs.readdirSync(PROJECTS_SOCKETS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const socketPath = path.join(PROJECTS_SOCKETS_DIR, entry.name, "default");
        try {
          const stat = fs.statSync(socketPath);
          if (stat.isSocket()) {
            sockets.push({ projectName: entry.name, socketPath });
          }
        } catch {}
      }
    }
  } catch {}
  return sockets;
}

module.exports = {
  OVERSEER_SOCKET,
  PROJECTS_SOCKETS_DIR,
  overseerTmuxCmd,
  projectTmuxCmd,
  overseerExec,
  projectExec,
  discoverProjectSockets,
};
