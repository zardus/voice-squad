#!/bin/bash
set -e

CAPTAIN_TMUX_SOCKET="${CAPTAIN_TMUX_SOCKET:-/run/squad-sockets/captain-tmux/default}"
WORKSPACE_TMUX_SOCKET="${WORKSPACE_TMUX_SOCKET:-/run/squad-sockets/workspace-tmux/default}"
CAPTAIN_TMUX_DIR="$(dirname "$CAPTAIN_TMUX_SOCKET")"
WORKSPACE_TMUX_DIR="$(dirname "$WORKSPACE_TMUX_SOCKET")"
export CAPTAIN_TMUX_SOCKET WORKSPACE_TMUX_SOCKET

# Ensure tmux socket directories are accessible
sudo mkdir -p "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR"
sudo chown ubuntu:ubuntu "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR"
sudo chmod 755 "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR"

# Wait for captain tmux session to be available
echo "[pane-monitor-entrypoint] Waiting for captain tmux session..."
timeout=120
while ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null; then
    echo "[pane-monitor-entrypoint] ERROR: captain tmux session not available after 120s"
    exit 1
fi
echo "[pane-monitor-entrypoint] captain tmux session found"

# Run pane monitor (replaces this process)
echo "[pane-monitor-entrypoint] Starting pane monitor..."
exec /opt/squad/pane-monitor.sh 2>&1 | tee -a /tmp/pane-monitor.log
