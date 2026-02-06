#!/bin/bash
set -e

CAPTAIN="${SQUAD_CAPTAIN:-claude}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Error: SQUAD_CAPTAIN must be 'claude' or 'codex' (got '$CAPTAIN')"
    exit 1
fi

# Start dockerd in the background (docker-in-docker)
sudo sh -c 'dockerd &>/var/log/dockerd.log' &

# Wait for docker to be ready
echo "Waiting for dockerd..."
timeout=30
while ! sudo docker info &>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done
if [ $timeout -eq 0 ]; then
    echo "Warning: dockerd failed to start within 30s, continuing anyway"
else
    echo "dockerd ready"
fi

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu

# Install captain instructions with the right filename
if [ "$CAPTAIN" = "claude" ]; then
    cp /opt/squad/captain/instructions.md /home/ubuntu/CLAUDE.md
else
    cp /opt/squad/captain/instructions.md /home/ubuntu/AGENTS.md
fi

# Install MCP config for the captain (tmux access)
cp /opt/squad/mcp-config.json /home/ubuntu/.squad-mcp.json

# Start the "agents" tmux session (detached, for worker agents)
tmux new-session -d -s agents -n main

echo "agents tmux session started"
echo "Starting $CAPTAIN as captain..."

# Start the captain
if [ "$CAPTAIN" = "claude" ]; then
    exec claude \
        --dangerously-skip-permissions \
        --mcp-config /home/ubuntu/.squad-mcp.json \
        "$@"
else
    exec codex \
        "$@"
fi
