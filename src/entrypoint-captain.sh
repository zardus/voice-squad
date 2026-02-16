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

# Ensure tmux socket directories are accessible
sudo mkdir -p /run/captain-tmux /run/workspace-tmux
sudo chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux
sudo chmod 755 /run/captain-tmux /run/workspace-tmux

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu
sudo chown -R ubuntu:ubuntu /home/ubuntu/.codex /home/ubuntu/.claude 2>/dev/null || true

# Source user environment if present (set -a auto-exports all vars)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Captain instructions in ~/captain/ — workers in ~/project/ never walk into here
mkdir -p /home/ubuntu/captain
mkdir -p /home/ubuntu/captain/archive

# Write config.yml so the voice server (and next restart) know the captain type
echo "type: $CAPTAIN" > "$CONFIG_FILE"
cp /opt/squad/captain/instructions.md /home/ubuntu/captain/CLAUDE.md
cp /opt/squad/captain/instructions.md /home/ubuntu/captain/AGENTS.md

# Generate VOICE_TOKEN if not provided via environment
if [ -z "${VOICE_TOKEN:-}" ]; then
    VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
    export VOICE_TOKEN
fi

# Write token to shared volume so other containers (voice-server) can read it
echo "$VOICE_TOKEN" > /home/ubuntu/.voice-token

echo "Starting $CAPTAIN as captain..."

# Wait for workspace tmux server to be ready
echo "[captain-entrypoint] Waiting for workspace tmux server..."
timeout=120
while ! tmux -S /run/workspace-tmux/default has-session 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S /run/workspace-tmux/default has-session 2>/dev/null; then
    echo "[captain-entrypoint] ERROR: workspace tmux server not available after 120s"
    exit 1
fi
echo "[captain-entrypoint] workspace tmux server found"

# Ensure TMUX_TMPDIR symlink exists so captain's raw tmux commands
# (which resolve $TMUX_TMPDIR/tmux-{UID}/default) find the workspace socket
mkdir -p /run/workspace-tmux/tmux-$(id -u)
ln -sf /run/workspace-tmux/default /run/workspace-tmux/tmux-$(id -u)/default

# Create captain tmux session on the captain's own tmux server
tmux -S /run/captain-tmux/default new-session -d -s captain -c /home/ubuntu/captain

# Launch captain inside the tmux session using the restart script.
# --fresh skips --continue/resume since this is the initial boot.
CAPTAIN_TMUX_SOCKET=/run/captain-tmux/default /opt/squad/restart-captain.sh "$CAPTAIN" --fresh

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
tmux -S /run/captain-tmux/default select-window -t captain:0

# Keep the container alive.
# NOTE: no `exec` — bash stays PID 1, sleep is a killable child.
# The voice server triggers a restart via: sudo pkill -P 1 sleep
# That kills this sleep, bash falls through to EOF and exits,
# and docker-compose restarts the container (reading config.yml for the captain type).
sleep infinity
