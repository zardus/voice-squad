#!/bin/bash
set -e

# Ensure tmux socket directories are accessible
sudo mkdir -p /run/captain-tmux /run/workspace-tmux
sudo chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux
sudo chmod 755 /run/captain-tmux /run/workspace-tmux

# Source user environment if present
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Use _OPENAI_API_KEY / _ANTHROPIC_API_KEY from ~/env if the primary vars are not set
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"

# Read VOICE_TOKEN from shared volume if not set via environment
if [ -z "${VOICE_TOKEN:-}" ]; then
    echo "[voice-entrypoint] Waiting for voice token from captain..."
    for i in $(seq 1 120); do
        if [ -f /home/ubuntu/.voice-token ]; then
            VOICE_TOKEN=$(cat /home/ubuntu/.voice-token)
            export VOICE_TOKEN
            break
        fi
        sleep 1
    done
    if [ -z "${VOICE_TOKEN:-}" ]; then
        echo "[voice-entrypoint] ERROR: VOICE_TOKEN not available after 120s"
        exit 1
    fi
fi
echo "[voice-entrypoint] VOICE_TOKEN set"

# Wait for captain tmux session to be available (captain container must start first)
echo "[voice-entrypoint] Waiting for captain tmux session..."
timeout=120
while ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null; then
    echo "[voice-entrypoint] ERROR: captain tmux session not available after 120s"
    exit 1
fi
echo "[voice-entrypoint] captain tmux session found"

# Start voice server
echo "[voice-entrypoint] Starting voice server..."
node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1 &
VOICE_PID=$!

# Wait for voice server to be listening
echo "[voice-entrypoint] Waiting for voice server on :3000..."
for i in $(seq 1 20); do
    if ! kill -0 "$VOICE_PID" 2>/dev/null; then
        echo "[voice-entrypoint] ERROR: Voice server crashed! Log:"
        cat /tmp/voice-server.log 2>/dev/null || true
        exit 1
    fi
    if grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then break; fi
    sleep 0.5
done

if ! grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then
    echo "[voice-entrypoint] WARNING: Voice server not listening after 10s"
fi

echo "[voice-entrypoint] Voice server started (PID $VOICE_PID)"

# Follow voice server log (keeps container alive)
echo "[voice-entrypoint] Voice server running. Following logs..."
exec tail -f /tmp/voice-server.log
