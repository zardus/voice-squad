#!/bin/bash
set -e

# Ensure tmux socket directory is accessible
sudo mkdir -p /run/tmux
sudo chown ubuntu:ubuntu /run/tmux
sudo chmod 755 /run/tmux

# Wait for tmux captain session to be available
echo "[pane-monitor-entrypoint] Waiting for tmux captain session..."
timeout=120
while ! tmux has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux has-session -t captain 2>/dev/null; then
    echo "[pane-monitor-entrypoint] ERROR: tmux captain session not available after 120s"
    exit 1
fi
echo "[pane-monitor-entrypoint] tmux captain session found"

# Run pane monitor (replaces this process)
echo "[pane-monitor-entrypoint] Starting pane monitor..."
exec /opt/squad/pane-monitor.sh 2>&1 | tee -a /tmp/pane-monitor.log
