#!/bin/bash
set -e

# Read overseer type from config file (shared volume), fall back to env var
CONFIG_FILE="/home/ubuntu/overseer/config.yml"
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_TYPE=$(grep -oP '^type:\s*\K\S+' "$CONFIG_FILE" 2>/dev/null || true)
    if [ -n "$CONFIG_TYPE" ]; then
        OVERSEER="$CONFIG_TYPE"
        echo "[overseer-entrypoint] Read overseer type from config: $OVERSEER"
    else
        OVERSEER="${SQUAD_OVERSEER:-codex}"
    fi
else
    OVERSEER="${SQUAD_OVERSEER:-codex}"
fi

if [ "$OVERSEER" != "claude" ] && [ "$OVERSEER" != "codex" ]; then
    echo "Error: Overseer type must be 'claude' or 'codex' (got '$OVERSEER')"
    exit 1
fi

OVERSEER_TMUX_SOCKET="${OVERSEER_TMUX_SOCKET:-/run/squad/tmux/overseer/default}"
OVERSEER_TMUX_DIR="$(dirname "$OVERSEER_TMUX_SOCKET")"
export OVERSEER_TMUX_SOCKET

# Ensure shared volume directories are accessible
sudo mkdir -p "$OVERSEER_TMUX_DIR" /run/squad/tmux/projects /run/squad/auth/claude /run/squad/auth/codex
sudo chown -R ubuntu:ubuntu /run/squad
sudo chmod 755 "$OVERSEER_TMUX_DIR" /run/squad/tmux/projects

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu

# Populate shared auth directory from persistent home volume (first container to start)
if [ -f /home/ubuntu/.claude.json ]; then
    cp -u /home/ubuntu/.claude.json /run/squad/auth/claude.json 2>/dev/null || true
fi
if [ -d /home/ubuntu/.claude ]; then
    cp -ru /home/ubuntu/.claude/. /run/squad/auth/claude/ 2>/dev/null || true
fi
if [ -d /home/ubuntu/.codex ]; then
    cp -ru /home/ubuntu/.codex/. /run/squad/auth/codex/ 2>/dev/null || true
fi

# Symlink auth from shared volume so all containers share credentials
ln -sfn /run/squad/auth/claude.json /home/ubuntu/.claude.json
ln -sfn /run/squad/auth/claude /home/ubuntu/.claude
ln -sfn /run/squad/auth/codex /home/ubuntu/.codex

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
mkdir -p /run/squad/auth/claude
if [ -f /home/ubuntu/.claude.json ]; then
    # Merge hasCompletedOnboarding into existing auth data
    jq '. + {hasCompletedOnboarding: true}' /home/ubuntu/.claude.json > /tmp/.claude.json.tmp \
        && mv /tmp/.claude.json.tmp /home/ubuntu/.claude.json
else
    echo '{"hasCompletedOnboarding": true}' > /home/ubuntu/.claude.json
fi

# Overseer working directory is /opt/squad/overseer (baked into image with CLAUDE.md + .claude/settings.json)
# Task files live under ~/tasks/ on the shared volume
mkdir -p /home/ubuntu/overseer
mkdir -p /home/ubuntu/tasks/pending
mkdir -p /home/ubuntu/tasks/archived
mkdir -p /home/ubuntu/projects

# Write config.yml so the hub (and next restart) know the overseer type
echo "type: $OVERSEER" > "$CONFIG_FILE"

# For codex overseers, also provide AGENTS.md
cp /opt/squad/overseer/CLAUDE.md /opt/squad/overseer/AGENTS.md 2>/dev/null || true

echo "Starting $OVERSEER as overseer..."

# Create overseer tmux session on the overseer's own tmux server
tmux -S "$OVERSEER_TMUX_SOCKET" new-session -d -s overseer -c /opt/squad/overseer

# Launch overseer inside the tmux session using the restart script.
OVERSEER_TMUX_SOCKET="$OVERSEER_TMUX_SOCKET" /opt/squad/restart-overseer.sh "$OVERSEER"

# Wait for voice URL from hub container (written to shared volume)
echo "[overseer-entrypoint] Waiting for voice URL from hub container..."
for i in $(seq 1 120); do
    if [ -f /home/ubuntu/.voice-url.txt ]; then
        VOICE_URL=$(cat /home/ubuntu/.voice-url.txt 2>/dev/null | head -1)
        if [ -n "$VOICE_URL" ]; then
            echo "[overseer-entrypoint] Voice URL: $VOICE_URL"
            break
        fi
    fi
    sleep 1
done

if [ -z "${VOICE_URL:-}" ]; then
    echo "[overseer-entrypoint] Warning: Voice URL not yet available. Check hub container."
fi

# Select the overseer window
tmux -S "$OVERSEER_TMUX_SOCKET" select-window -t overseer:0

# Keep the container alive.
# NOTE: no `exec` — bash stays PID 1, sleep is a killable child.
# The hub triggers a restart via: sudo pkill -P 1 sleep
# That kills this sleep, bash falls through to EOF and exits,
# and docker-compose restarts the container (reading config.yml for the overseer type).
/bin/sleep infinity
