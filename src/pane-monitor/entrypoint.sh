#!/bin/bash
set -e

# Ensure tmux socket directories are accessible
sudo mkdir -p /run/captain-tmux /run/workspace-tmux
sudo chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux
sudo chmod 755 /run/captain-tmux /run/workspace-tmux

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
