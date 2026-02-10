#!/bin/bash
set -e

IMAGE_NAME="squad"
CAPTAIN="${1:-claude}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Usage: $0 [claude|codex]"
    echo "  Default: claude"
    exit 1
fi

# Build if needed
echo "Building squad image..."
docker build -t "$IMAGE_NAME" -f "$(dirname "$0")/src/Dockerfile" "$(dirname "$0")/src"

shift 2>/dev/null || true

SSH_AGENT_ARGS=()
if [ -n "$SSH_AUTH_SOCK" ]; then
    SSH_AGENT_ARGS+=(-v "$SSH_AUTH_SOCK:/tmp/ssh-agent.sock" -e SSH_AUTH_SOCK=/tmp/ssh-agent.sock)
fi

exec docker run -it --rm --privileged \
    -p 3000:3000 \
    -v "$(pwd)/home:/home/ubuntu" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
    -e OPENAI_API_KEY="${OPENAI_API_KEY}" \
    -e SQUAD_CAPTAIN="$CAPTAIN" \
    "${SSH_AGENT_ARGS[@]}" \
    "$IMAGE_NAME" \
    "$@"
