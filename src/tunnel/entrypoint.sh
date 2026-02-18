#!/bin/bash
set -e

VOICE_SERVER_ORIGIN="${VOICE_SERVER_ORIGIN:-http://voice-server:3000}"

# Read VOICE_TOKEN from shared volume (written by voice-server) if not set via environment
if [ -z "${VOICE_TOKEN:-}" ]; then
    echo "[tunnel] Waiting for voice token from voice-server..."
    for i in $(seq 1 120); do
        if [ -f /home/ubuntu/.voice-token ]; then
            VOICE_TOKEN=$(cat /home/ubuntu/.voice-token)
            export VOICE_TOKEN
            break
        fi
        sleep 1
    done
    if [ -z "${VOICE_TOKEN:-}" ]; then
        echo "[tunnel] ERROR: VOICE_TOKEN not available after 120s"
        exit 1
    fi
fi
echo "[tunnel] VOICE_TOKEN set"

# Start cloudflared tunnel pointing at the voice-server container
echo "[tunnel] Starting cloudflared tunnel -> ${VOICE_SERVER_ORIGIN}"
cloudflared tunnel --url "${VOICE_SERVER_ORIGIN}" > /tmp/cloudflared.log 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL (up to 15s)
echo "[tunnel] Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "[tunnel] ERROR: cloudflared crashed! Log:"
        cat /tmp/cloudflared.log 2>/dev/null || true
        exit 1
    fi
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then break; fi
    sleep 0.5
done

if [ -n "$TUNNEL_URL" ]; then
    VOICE_URL="${TUNNEL_URL}?token=${VOICE_TOKEN}"
else
    echo "[tunnel] Warning: Could not detect tunnel URL. Check /tmp/cloudflared.log"
    VOICE_URL="http://localhost:3000?token=${VOICE_TOKEN}"
fi

# Write URL to shared volume
echo "$VOICE_URL" > /tmp/voice-url.txt
echo "$VOICE_URL" > /home/ubuntu/.voice-url.txt 2>/dev/null || true

# Show QR code
echo ""
echo "============================================"
echo "  Voice UI URL:"
echo "  $VOICE_URL"
echo "============================================"
echo ""
node /opt/squad/show-qr.js "$VOICE_URL" 2>/dev/null || true
echo ""

# Keep container alive by following cloudflared logs
echo "[tunnel] Tunnel running (PID $TUNNEL_PID). Following logs..."
exec tail -f /tmp/cloudflared.log
