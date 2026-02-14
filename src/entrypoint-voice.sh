#!/bin/bash
set -e

# Ensure tmux socket directory is accessible
sudo mkdir -p /run/tmux
sudo chown ubuntu:ubuntu /run/tmux
sudo chmod 755 /run/tmux

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
    echo "[voice-entrypoint] Waiting for voice token from workspace..."
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

# Wait for tmux captain session to be available (workspace container must start first)
echo "[voice-entrypoint] Waiting for tmux captain session..."
timeout=120
while ! tmux has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux has-session -t captain 2>/dev/null; then
    echo "[voice-entrypoint] ERROR: tmux captain session not available after 120s"
    exit 1
fi
echo "[voice-entrypoint] tmux captain session found"

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
    echo "[voice-entrypoint] WARNING: Voice server not listening after 10s — starting tunnel anyway"
fi

echo "[voice-entrypoint] Voice server started (PID $VOICE_PID)"

# Start cloudflared tunnel
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &

# Wait for tunnel URL (up to 15s)
echo "[voice-entrypoint] Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then break; fi
    sleep 0.5
done

if [ -n "$TUNNEL_URL" ]; then
    VOICE_URL="${TUNNEL_URL}?token=${VOICE_TOKEN}"
else
    echo "[voice-entrypoint] Warning: Could not detect tunnel URL. Check /tmp/cloudflared.log"
    VOICE_URL="http://localhost:3000?token=${VOICE_TOKEN}"
fi

# Write URL to shared volume so workspace container can display it
echo "$VOICE_URL" > /tmp/voice-url.txt
echo "$VOICE_URL" > /home/ubuntu/.voice-url.txt 2>/dev/null || true

# Show QR code
echo ""
echo "============================================"
echo "  Voice UI URL:"
echo "  $VOICE_URL"
echo "============================================"
echo ""
node /opt/squad/voice/show-qr.js "$VOICE_URL" 2>/dev/null || true
echo ""

# Also create a tmux window in the captain session for the QR display
tmux new-window -t captain -n voice 2>/dev/null || true
tmux send-keys -t captain:voice "echo 'Voice URL: ${VOICE_URL}' && echo 'Voice server running in voice-server container' && echo 'Log: docker compose logs voice-server'" Enter 2>/dev/null || true

# Follow voice server log (keeps container alive)
echo "[voice-entrypoint] Voice server running. Following logs..."
exec tail -f /tmp/voice-server.log
