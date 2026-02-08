#!/bin/bash
set -e

CAPTAIN="${SQUAD_CAPTAIN:-claude}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Error: SQUAD_CAPTAIN must be 'claude' or 'codex' (got '$CAPTAIN')"
    exit 1
fi

# Install captain instructions with the right filename
if [ "$CAPTAIN" = "claude" ]; then
    cp /opt/squad/captain/instructions.md /home/ubuntu/CLAUDE.md
else
    cp /opt/squad/captain/instructions.md /home/ubuntu/AGENTS.md
fi

# Install MCP config for the captain (tmux access)
cp /opt/squad/mcp-config.json /home/ubuntu/.squad-mcp.json
mkdir -p /home/ubuntu/.codex
cp /opt/squad/codex-mcp-config.toml /home/ubuntu/.codex/config.toml

# Generate auth token for voice interface
VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
export VOICE_TOKEN

echo "Starting $CAPTAIN as captain..."

# Create a tmux session for the captain
tmux new-session -d -s captain

# Launch captain inside the tmux session
if [ "$CAPTAIN" = "claude" ]; then
    tmux send-keys -t captain "claude --dangerously-skip-permissions --mcp-config /home/ubuntu/.squad-mcp.json $*" Enter
else
    tmux send-keys -t captain "codex --dangerously-bypass-approvals-and-sandbox $*" Enter
fi

# Start voice server
echo "Starting voice server..."
node /opt/squad/voice/server.js &
VOICE_PID=$!

# Start cloudflared tunnel
echo "Starting cloudflared tunnel..."
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL to appear (up to 15s)
echo "Waiting for tunnel URL..."
for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 0.5
done

VOICE_URL=""
if [ -n "$TUNNEL_URL" ]; then
    VOICE_URL="${TUNNEL_URL}?token=${VOICE_TOKEN}"
else
    echo "Warning: Could not detect tunnel URL. Check /tmp/cloudflared.log"
    VOICE_URL="http://localhost:3000?token=${VOICE_TOKEN}"
fi

# Show QR code for easy phone scanning
node /opt/squad/voice/show-qr.js "$VOICE_URL"

# Save URL to file for later retrieval
echo "$VOICE_URL" > /tmp/voice-url.txt

# Attach to captain session (terminal still works normally)
exec tmux attach -t captain
