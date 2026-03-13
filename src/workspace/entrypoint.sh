#!/bin/bash
set -e

PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME env var is required}"

SOCKET_DIR="/run/squad/tmux/projects/${PROJECT_NAME}"
SOCKET_PATH="${SOCKET_DIR}/default"
export TMUX_TMPDIR="$SOCKET_DIR"

# Ensure socket directory is accessible
sudo mkdir -p "$SOCKET_DIR"
sudo chown ubuntu:ubuntu "$SOCKET_DIR"
sudo chmod 755 "$SOCKET_DIR"

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu

# Symlink auth from shared volume so workers share credentials
ln -sfn /run/squad/auth/claude.json /home/ubuntu/.claude.json
ln -sfn /run/squad/auth/claude /home/ubuntu/.claude
ln -sfn /run/squad/auth/codex /home/ubuntu/.codex

# Expose shared ssh-agent to workers
export SSH_AUTH_SOCK=/run/squad/ssh-agent.sock

# Source user environment if present (set -a auto-exports all vars)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Use underscored key names from ~/env when primary vars are unset.
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"

# Pre-configure Claude Code onboarding (skip first-run dialogs)
if [ -f /home/ubuntu/.claude.json ]; then
    jq '. + {hasCompletedOnboarding: true}' /home/ubuntu/.claude.json > /tmp/.claude.json.tmp \
        && mv /tmp/.claude.json.tmp /home/ubuntu/.claude.json 2>/dev/null || true
else
    echo '{"hasCompletedOnboarding": true}' > /home/ubuntu/.claude.json 2>/dev/null || true
fi

# Create the agents tmux session at a fixed socket path (workers run as windows here)
# The initial window is named PLACEHOLDER and is hidden from the UI;
# actual workers are added as new windows by create-worker.
tmux -S "$SOCKET_PATH" new-session -d -s agents -n PLACEHOLDER -c /home/ubuntu

# Keep the container alive
exec sleep infinity
