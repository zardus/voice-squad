#!/bin/bash
set -e

OVERSEER_TMUX_SOCKET="${OVERSEER_TMUX_SOCKET:-/run/squad-sockets/overseer-tmux/default}"
PROJECTS_SOCKETS_DIR="${PROJECTS_SOCKETS_DIR:-/run/squad-sockets/projects}"
OVERSEER_TMUX_DIR="$(dirname "$OVERSEER_TMUX_SOCKET")"
export OVERSEER_TMUX_SOCKET PROJECTS_SOCKETS_DIR

# Ensure tmux socket directories are accessible
sudo mkdir -p "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR"
sudo chown ubuntu:ubuntu "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR"
sudo chmod 755 "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR"

# Wait for overseer tmux session to be available
echo "[pane-monitor-entrypoint] Waiting for overseer tmux session..."
timeout=120
while ! tmux -S "$OVERSEER_TMUX_SOCKET" has-session -t overseer 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$OVERSEER_TMUX_SOCKET" has-session -t overseer 2>/dev/null; then
    echo "[pane-monitor-entrypoint] ERROR: overseer tmux session not available after 120s"
    exit 1
fi
echo "[pane-monitor-entrypoint] overseer tmux session found"

# Run pane monitor (replaces this process)
echo "[pane-monitor-entrypoint] Starting pane monitor..."
exec /opt/squad/pane-monitor.sh 2>&1 | tee -a /tmp/pane-monitor.log
