#!/bin/bash
set -e

CAPTAIN="${SQUAD_CAPTAIN:-claude}"
COMPOSE_MODE="${COMPOSE_MODE:-}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Error: SQUAD_CAPTAIN must be 'claude' or 'codex' (got '$CAPTAIN')"
    exit 1
fi

# Clean up any old captain instructions from home dir (persistent volume)
rm -f /home/ubuntu/CLAUDE.md /home/ubuntu/AGENTS.md

# Captain instructions in ~/captain/ — workers in ~/project/ never walk into here
mkdir -p /home/ubuntu/captain
mkdir -p /home/ubuntu/captain/archive
cp /opt/squad/captain/instructions.md /home/ubuntu/captain/CLAUDE.md
cp /opt/squad/captain/instructions.md /home/ubuntu/captain/AGENTS.md

# Source ~/env for API keys (set -a auto-exports all vars to child processes)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Generate VOICE_TOKEN if not provided via environment
if [ -z "${VOICE_TOKEN:-}" ]; then
    VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
    export VOICE_TOKEN
fi

# Write token to shared volume so other containers (voice-server) can read it
echo "$VOICE_TOKEN" > /home/ubuntu/.voice-token

echo "Starting $CAPTAIN as captain..."

# Create a tmux session for the captain (starts in ~/captain/ where its instructions live)
tmux new-session -d -s captain -c /home/ubuntu/captain

if [ -n "$COMPOSE_MODE" ]; then
    # In compose mode, voice server and pane monitor run in their own containers.
    echo "Compose mode: voice server and pane monitor run in separate containers."
else
    # Standalone mode: start pane monitor in a tmux window
    if ! pgrep -f "/opt/squad/pane-monitor.sh" >/dev/null 2>&1; then
        tmux new-window -t captain -n idle-monitor
        tmux send-keys -t captain:idle-monitor "/opt/squad/pane-monitor.sh 2>&1 | tee -a /tmp/pane-monitor.log" Enter
    fi
fi

# Launch captain inside the tmux session using the unified restart script.
# --fresh skips --continue/resume since this is the initial boot.
/opt/squad/restart-captain.sh "$CAPTAIN" --fresh

if [ -n "$COMPOSE_MODE" ]; then
    # In compose mode, voice server runs in its own container.
    # Wait for voice URL file from voice-server container (written to shared volume).
    echo "Waiting for voice URL from voice-server container..."
    for i in $(seq 1 60); do
        if [ -f /home/ubuntu/.voice-url.txt ]; then
            VOICE_URL=$(cat /home/ubuntu/.voice-url.txt 2>/dev/null | head -1)
            if [ -n "$VOICE_URL" ]; then
                echo "$VOICE_URL" > /tmp/voice-url.txt
                echo "Voice URL: $VOICE_URL"
                break
            fi
        fi
        sleep 1
    done

    if [ -z "${VOICE_URL:-}" ]; then
        echo "Warning: Voice URL not yet available. Check voice-server container."
    fi
else
    # Standalone mode: start voice server and cloudflared here
    OPENAI_API_KEY="$_OPENAI_API_KEY" ANTHROPIC_API_KEY="$_ANTHROPIC_API_KEY" \
        setsid node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1 &
    VOICE_PID=$!

    echo "Waiting for voice server on :3000..."
    for i in $(seq 1 20); do
        if ! kill -0 "$VOICE_PID" 2>/dev/null; then
            echo "ERROR: Voice server crashed! Check /tmp/voice-server.log:"
            tail -10 /tmp/voice-server.log 2>/dev/null || true
            exit 1
        fi
        if grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then break; fi
        sleep 0.5
    done

    if ! grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then
        echo "WARNING: Voice server not listening after 10s — starting tunnel anyway"
    fi

    cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &

    echo "Waiting for tunnel URL..."
    for i in $(seq 1 30); do
        TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
        if [ -n "$TUNNEL_URL" ]; then break; fi
        sleep 0.5
    done

    if [ -n "$TUNNEL_URL" ]; then
        VOICE_URL="${TUNNEL_URL}?token=${VOICE_TOKEN}"
    else
        echo "Warning: Could not detect tunnel URL. Check /tmp/cloudflared.log"
        VOICE_URL="http://localhost:3000?token=${VOICE_TOKEN}"
    fi

    echo "$VOICE_URL" > /tmp/voice-url.txt
fi

# Select the captain window (window 0) but do not attach:
# the container foreground is /opt/squad/main-menu.sh, which can attach on demand.
tmux select-window -t captain:0
exit 0
