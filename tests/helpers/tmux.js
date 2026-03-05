/**
 * Shared tmux helpers for tests — wraps socket-aware tmux commands.
 *
 * Uses CAPTAIN_TMUX_SOCKET / PROJECTS_SOCKETS_DIR env vars when set.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CAPTAIN_SOCKET = process.env.CAPTAIN_TMUX_SOCKET || "";
const PROJECTS_SOCKETS_DIR = process.env.PROJECTS_SOCKETS_DIR || "/run/squad-sockets/projects";

function captainTmuxCmd(args) {
  const socketArgs = CAPTAIN_SOCKET ? `-S ${CAPTAIN_SOCKET} ` : "";
  return `tmux ${socketArgs}${args}`;
}

function projectTmuxCmd(projectName, args) {
  const socketPath = path.join(PROJECTS_SOCKETS_DIR, projectName, "default");
  return `tmux -S ${socketPath} ${args}`;
}

function captainExec(args, opts = {}) {
  return execSync(captainTmuxCmd(args), {
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
  CAPTAIN_SOCKET,
  PROJECTS_SOCKETS_DIR,
  captainTmuxCmd,
  projectTmuxCmd,
  captainExec,
  projectExec,
  discoverProjectSockets,
};
