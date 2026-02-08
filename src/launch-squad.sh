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

# Create a second window for the voice server
tmux new-window -t captain -n voice

# Save env vars for the voice server (tmux windows don't inherit env)
cat > /tmp/voice-env.sh << ENVEOF
export OPENAI_API_KEY="${OPENAI_API_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"
export VOICE_TOKEN="${VOICE_TOKEN}"
export SQUAD_CAPTAIN="${CAPTAIN}"
ENVEOF

# Write a startup script that the voice window will run
cat > /tmp/start-voice.sh << 'SCRIPT'
#!/bin/bash
source /tmp/voice-env.sh

# Start voice server
node /opt/squad/voice/server.js &

# Start cloudflared tunnel
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
node /opt/squad/voice/show-qr.js "$VOICE_URL"

# Keep window alive
wait
SCRIPT
chmod +x /tmp/start-voice.sh

# Launch the voice startup in the voice window
tmux send-keys -t captain:voice "/tmp/start-voice.sh" Enter

# Select the captain window (window 0) and attach
tmux select-window -t captain:0
exec tmux attach -t captain
