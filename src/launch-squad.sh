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

echo "Starting $CAPTAIN as captain..."

# Start the captain
if [ "$CAPTAIN" = "claude" ]; then
    exec claude \
        --dangerously-skip-permissions \
        --mcp-config /home/ubuntu/.squad-mcp.json \
        "$@"
else
    exec codex \
        --dangerously-bypass-approvals-and-sandbox \
        "$@"
fi
