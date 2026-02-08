#!/bin/bash
set -e

CAPTAIN="${SQUAD_CAPTAIN:-claude}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Error: SQUAD_CAPTAIN must be 'claude' or 'codex' (got '$CAPTAIN')"
    exit 1
fi

# Clean up any old captain instructions from home dir (persistent volume)
rm -f /home/ubuntu/CLAUDE.md /home/ubuntu/AGENTS.md

# Captain instructions in ~/captain/ — workers in ~/project/ never walk into here
mkdir -p /home/ubuntu/captain
if [ "$CAPTAIN" = "claude" ]; then
    cp /opt/squad/captain/instructions.md /home/ubuntu/captain/CLAUDE.md
else
    cp /opt/squad/captain/instructions.md /home/ubuntu/captain/AGENTS.md
fi

# Install MCP config for the captain (tmux access)
cp /opt/squad/mcp-config.json /home/ubuntu/.squad-mcp.json
mkdir -p /home/ubuntu/.codex
cp /opt/squad/codex-mcp-config.toml /home/ubuntu/.codex/config.toml

# Source ~/env for API keys (set -a auto-exports all vars to child processes)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Generate auth token for voice interface
VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
export VOICE_TOKEN

echo "Starting $CAPTAIN as captain..."

# Create a tmux session for the captain (starts in ~/captain/ where its instructions live)
tmux new-session -d -s captain -c /home/ubuntu/captain

# Launch captain inside the tmux session
if [ "$CAPTAIN" = "claude" ]; then
    tmux send-keys -t captain "claude --dangerously-skip-permissions --mcp-config /home/ubuntu/.squad-mcp.json $*" Enter
else
    tmux send-keys -t captain "codex --dangerously-bypass-approvals-and-sandbox $*" Enter
fi

# Start voice server with API keys inline (not exported, so captain CLIs don't see them)
OPENAI_API_KEY="$_OPENAI_API_KEY" ANTHROPIC_API_KEY="$_ANTHROPIC_API_KEY" \
    node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1 &
VOICE_PID=$!

# Wait for voice server to be listening before starting the tunnel
echo "Waiting for voice server on :3000..."
for i in $(seq 1 20); do
    if ! kill -0 "$VOICE_PID" 2>/dev/null; then
        echo "ERROR: Voice server crashed! Check /tmp/voice-server.log:"
        tail -10 /tmp/voice-server.log 2>/dev/null || true
        exit 1
    fi
    if ss -tln | grep -q ':3000 '; then break; fi
    sleep 0.5
done

if ! ss -tln | grep -q ':3000 '; then
    echo "WARNING: Voice server not listening after 10s — starting tunnel anyway"
fi

cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &

# Wait for tunnel URL (up to 15s)
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

# Show QR code in a second tmux window
tmux new-window -t captain -n voice
tmux send-keys -t captain:voice "node /opt/squad/voice/show-qr.js '${VOICE_URL}' && echo 'Voice server log: /tmp/voice-server.log' && tail -f /tmp/voice-server.log" Enter

# Select the captain window (window 0) and attach
tmux select-window -t captain:0
exec tmux attach -t captain
