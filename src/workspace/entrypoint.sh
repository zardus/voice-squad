#!/bin/bash
set -e

PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME env var is required}"

SOCKET_DIR="/run/squad-sockets/projects/${PROJECT_NAME}"
SOCKET_PATH="${SOCKET_DIR}/default"
export TMUX_TMPDIR="$SOCKET_DIR"

# Ensure socket directory is accessible
sudo mkdir -p "$SOCKET_DIR"
sudo chown ubuntu:ubuntu "$SOCKET_DIR"
sudo chmod 755 "$SOCKET_DIR"

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu
sudo chown -R ubuntu:ubuntu /home/ubuntu/.codex /home/ubuntu/.claude 2>/dev/null || true

# Source user environment if present (set -a auto-exports all vars)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Use underscored key names from ~/env when primary vars are unset.
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"

# Create the agents tmux session at a fixed socket path (workers run as windows here)
# The initial window is named PLACEHOLDER and is hidden from the UI;
# actual workers are added as new windows by create-worker.
tmux -S "$SOCKET_PATH" new-session -d -s agents -n PLACEHOLDER -c /home/ubuntu

# Keep the container alive
exec sleep infinity
