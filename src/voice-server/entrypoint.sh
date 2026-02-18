#!/bin/bash
set -e

CAPTAIN_TMUX_SOCKET="${CAPTAIN_TMUX_SOCKET:-/run/squad-sockets/captain-tmux/default}"
WORKSPACE_TMUX_SOCKET="${WORKSPACE_TMUX_SOCKET:-/run/squad-sockets/workspace-tmux/default}"
SPEAK_SOCKET_PATH="${SPEAK_SOCKET_PATH:-/run/squad-sockets/speak.sock}"
CAPTAIN_TMUX_DIR="$(dirname "$CAPTAIN_TMUX_SOCKET")"
WORKSPACE_TMUX_DIR="$(dirname "$WORKSPACE_TMUX_SOCKET")"
SPEAK_SOCKET_DIR="$(dirname "$SPEAK_SOCKET_PATH")"
export CAPTAIN_TMUX_SOCKET WORKSPACE_TMUX_SOCKET SPEAK_SOCKET_PATH

# Ensure tmux socket directories are accessible
sudo mkdir -p "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$SPEAK_SOCKET_DIR"
sudo chown ubuntu:ubuntu "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$SPEAK_SOCKET_DIR"
sudo chmod 755 "$CAPTAIN_TMUX_DIR" "$WORKSPACE_TMUX_DIR" "$SPEAK_SOCKET_DIR"

# Source user environment if present
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Use _OPENAI_API_KEY / _ANTHROPIC_API_KEY from ~/env if the primary vars are not set
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"

# Resolve VOICE_TOKEN from env -> persisted file -> generated fallback.
if [ -z "${VOICE_TOKEN:-}" ] && [ -f /home/ubuntu/.voice-token ]; then
    VOICE_TOKEN=$(head -1 /home/ubuntu/.voice-token | tr -d '\r\n')
    export VOICE_TOKEN
    echo "[voice-entrypoint] Loaded VOICE_TOKEN from /home/ubuntu/.voice-token"
fi

if [ -z "${VOICE_TOKEN:-}" ]; then
    VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
    export VOICE_TOKEN
    echo "[voice-entrypoint] Generated VOICE_TOKEN"
fi

echo "$VOICE_TOKEN" > /home/ubuntu/.voice-token
chmod 600 /home/ubuntu/.voice-token 2>/dev/null || true
echo "[voice-entrypoint] VOICE_TOKEN ready"

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
    if grep -q 'server listening on :' /tmp/voice-server.log 2>/dev/null; then break; fi
    sleep 0.5
done

if ! grep -q 'server listening on :' /tmp/voice-server.log 2>/dev/null; then
    echo "[voice-entrypoint] WARNING: Voice server not listening after 10s"
fi

echo "[voice-entrypoint] Voice server started (PID $VOICE_PID)"

# Follow voice server log (keeps container alive)
echo "[voice-entrypoint] Voice server running. Following logs..."
exec tail -f /tmp/voice-server.log
