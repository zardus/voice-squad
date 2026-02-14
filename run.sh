#!/bin/bash
set -e

cd "$(dirname "$0")"

CAPTAIN="${1:-claude}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "Usage: $0 [claude|codex]"
    echo "  Default: claude"
    exit 1
fi

# Generate a voice token for this session
VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

# Export variables for docker compose
export SQUAD_CAPTAIN="$CAPTAIN"
export VOICE_TOKEN
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export GH_TOKEN="${GH_TOKEN:-}"

echo "Starting squad with captain: $CAPTAIN"
echo "Building and launching containers..."

exec docker compose up --build
