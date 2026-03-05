#!/bin/bash
set -e

# Read captain type from config file (shared volume), fall back to env var
CONFIG_FILE="/home/ubuntu/captain/config.yml"
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_TYPE=$(grep -oP '^type:\s*\K\S+' "$CONFIG_FILE" 2>/dev/null || true)
    if [ -n "$CONFIG_TYPE" ]; then
        CAPTAIN="$CONFIG_TYPE"
        echo "[captain-entrypoint] Read captain type from config: $CAPTAIN"
    else
        CAPTAIN="${SQUAD_CAPTAIN:-claude}"
    fi
else
    CAPTAIN="${SQUAD_CAPTAIN:-claude}"
fi

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Error: Captain type must be 'claude' or 'codex' (got '$CAPTAIN')"
    exit 1
fi

CAPTAIN_TMUX_SOCKET="${CAPTAIN_TMUX_SOCKET:-/run/squad-sockets/captain-tmux/default}"
CAPTAIN_TMUX_DIR="$(dirname "$CAPTAIN_TMUX_SOCKET")"
export CAPTAIN_TMUX_SOCKET

# Ensure tmux socket directories are accessible
sudo mkdir -p "$CAPTAIN_TMUX_DIR" /run/squad-sockets/projects
sudo chown ubuntu:ubuntu "$CAPTAIN_TMUX_DIR" /run/squad-sockets/projects
sudo chmod 755 "$CAPTAIN_TMUX_DIR" /run/squad-sockets/projects

# Ensure Docker socket is accessible (host socket may be owned by root)
if [ -S /var/run/docker.sock ]; then
    sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

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

# Pre-configure Claude Code onboarding (skip first-run dialogs)
mkdir -p /home/ubuntu/.claude
if [ -f /home/ubuntu/.claude.json ]; then
    # Merge hasCompletedOnboarding into existing auth data
    jq '. + {hasCompletedOnboarding: true}' /home/ubuntu/.claude.json > /tmp/.claude.json.tmp \
        && mv /tmp/.claude.json.tmp /home/ubuntu/.claude.json
else
    echo '{"hasCompletedOnboarding": true}' > /home/ubuntu/.claude.json
fi

# Captain working directory is /opt/squad/captain (baked into image with CLAUDE.md + .claude/settings.json)
# Task files live under ~/captain/tasks/ on the shared volume
mkdir -p /home/ubuntu/captain
mkdir -p /home/ubuntu/captain/tasks/pending
mkdir -p /home/ubuntu/captain/tasks/archived
mkdir -p /home/ubuntu/projects

# Write config.yml so the voice server (and next restart) know the captain type
echo "type: $CAPTAIN" > "$CONFIG_FILE"

# For codex captains, also provide AGENTS.md
cp /opt/squad/captain/CLAUDE.md /opt/squad/captain/AGENTS.md 2>/dev/null || true

echo "Starting $CAPTAIN as captain..."

# Create captain tmux session on the captain's own tmux server
tmux -S "$CAPTAIN_TMUX_SOCKET" new-session -d -s captain -c /opt/squad/captain

# Launch captain inside the tmux session using the restart script.
CAPTAIN_TMUX_SOCKET="$CAPTAIN_TMUX_SOCKET" /opt/squad/restart-captain.sh "$CAPTAIN"

# Wait for voice URL from voice-server container (written to shared volume)
echo "[captain-entrypoint] Waiting for voice URL from voice-server container..."
for i in $(seq 1 120); do
    if [ -f /home/ubuntu/.voice-url.txt ]; then
        VOICE_URL=$(cat /home/ubuntu/.voice-url.txt 2>/dev/null | head -1)
        if [ -n "$VOICE_URL" ]; then
            echo "[captain-entrypoint] Voice URL: $VOICE_URL"
            break
        fi
    fi
    sleep 1
done

if [ -z "${VOICE_URL:-}" ]; then
    echo "[captain-entrypoint] Warning: Voice URL not yet available. Check voice-server container."
fi

# Select the captain window
tmux -S "$CAPTAIN_TMUX_SOCKET" select-window -t captain:0

# Keep the container alive.
# NOTE: no `exec` — bash stays PID 1, sleep is a killable child.
# The voice server triggers a restart via: sudo pkill -P 1 sleep
# That kills this sleep, bash falls through to EOF and exits,
# and docker-compose restarts the container (reading config.yml for the captain type).
/bin/sleep infinity
