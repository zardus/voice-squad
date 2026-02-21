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
WORKSPACE_TMUX_SOCKET="${WORKSPACE_TMUX_SOCKET:-/run/squad-sockets/workspace-tmux/default}"
CAPTAIN_TMUX_DIR="$(dirname "$CAPTAIN_TMUX_SOCKET")"
WORKSPACE_TMUX_DIR="$(dirname "$WORKSPACE_TMUX_SOCKET")"
TMUX_TMPDIR="${TMUX_TMPDIR:-$WORKSPACE_TMUX_DIR}"
export CAPTAIN_TMUX_SOCKET WORKSPACE_TMUX_SOCKET TMUX_TMPDIR

# Ensure tmux socket directories are accessible
sudo mkdir -p "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"
sudo chown ubuntu:ubuntu "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"
sudo chmod 755 "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"

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

# Write config.yml so the voice server (and next restart) know the captain type
echo "type: $CAPTAIN" > "$CONFIG_FILE"

# For codex captains, also provide AGENTS.md
cp /opt/squad/captain/CLAUDE.md /opt/squad/captain/AGENTS.md 2>/dev/null || true

echo "Starting $CAPTAIN as captain..."

# Wait for workspace tmux server to be ready
echo "[captain-entrypoint] Waiting for workspace tmux server..."
timeout=120
while ! tmux -S "$WORKSPACE_TMUX_SOCKET" has-session 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$WORKSPACE_TMUX_SOCKET" has-session 2>/dev/null; then
    echo "[captain-entrypoint] ERROR: workspace tmux server not available after 120s"
    exit 1
fi
echo "[captain-entrypoint] workspace tmux server found"

# Ensure TMUX_TMPDIR symlink exists so captain's raw tmux commands
# (which resolve $TMUX_TMPDIR/tmux-{UID}/default) find the workspace socket
mkdir -p "$TMUX_TMPDIR/tmux-$(id -u)"
ln -sf "$WORKSPACE_TMUX_SOCKET" "$TMUX_TMPDIR/tmux-$(id -u)/default"

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
