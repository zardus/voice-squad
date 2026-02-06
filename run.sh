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
docker build -t "$IMAGE_NAME" "$(dirname "$0")"

shift 2>/dev/null || true

exec docker run -it --rm --privileged \
    -v "$(pwd)/home:/home/ubuntu" \
    -v "${HOME}/.claude:/home/ubuntu/.claude" \
    -v "${HOME}/.claude.json:/home/ubuntu/.claude.json" \
    -v "${HOME}/.codex:/home/ubuntu/.codex" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
    -e OPENAI_API_KEY="${OPENAI_API_KEY}" \
    -e SQUAD_CAPTAIN="$CAPTAIN" \
    "$IMAGE_NAME" \
    "$@"
