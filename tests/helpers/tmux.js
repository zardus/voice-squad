/**
 * Shared tmux helpers for tests — wraps socket-aware tmux commands.
 *
 * Uses CAPTAIN_TMUX_SOCKET / WORKSPACE_TMUX_SOCKET env vars when set.
 */
const { execSync } = require("child_process");

const CAPTAIN_SOCKET = process.env.CAPTAIN_TMUX_SOCKET || "";
const WORKSPACE_SOCKET = process.env.WORKSPACE_TMUX_SOCKET || "";

function captainTmuxCmd(args) {
  const socketArgs = CAPTAIN_SOCKET ? `-S ${CAPTAIN_SOCKET} ` : "";
  return `tmux ${socketArgs}${args}`;
}

function workspaceTmuxCmd(args) {
  const socketArgs = WORKSPACE_SOCKET ? `-S ${WORKSPACE_SOCKET} ` : "";
  return `tmux ${socketArgs}${args}`;
}

function captainExec(args, opts = {}) {
  return execSync(captainTmuxCmd(args), {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

function workspaceExec(args, opts = {}) {
  return execSync(workspaceTmuxCmd(args), {
    encoding: "utf8",
    timeout: 5000,
    ...opts,
  });
}

module.exports = {
  CAPTAIN_SOCKET,
  WORKSPACE_SOCKET,
  captainTmuxCmd,
  workspaceTmuxCmd,
  captainExec,
  workspaceExec,
};
