#!/usr/bin/env bash
# Test-runner entrypoint: waits for infrastructure, then runs Playwright.
set -euo pipefail

OVERSEER_TMUX_SOCKET="${OVERSEER_TMUX_SOCKET:-/run/squad-sockets/overseer-tmux/default}"
PROJECTS_SOCKETS_DIR="${PROJECTS_SOCKETS_DIR:-/run/squad-sockets/projects}"
OVERSEER_TMUX_DIR="$(dirname "$OVERSEER_TMUX_SOCKET")"
export OVERSEER_TMUX_SOCKET PROJECTS_SOCKETS_DIR

# Ensure tmux socket dirs are accessible
sudo mkdir -p "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR" 2>/dev/null || true
sudo chown ubuntu:ubuntu "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR" 2>/dev/null || true
sudo chmod 755 "$OVERSEER_TMUX_DIR" "$PROJECTS_SOCKETS_DIR" 2>/dev/null || true

# Wait for overseer tmux session (started by overseer container)
echo "Waiting for overseer tmux session..."
timeout=30
while ! tmux -S "$OVERSEER_TMUX_SOCKET" has-session -t overseer 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$OVERSEER_TMUX_SOCKET" has-session -t overseer 2>/dev/null; then
    echo "ERROR: overseer tmux session not available after 30s"
    exit 1
fi
echo "[ok] overseer tmux session found"

# Discover VOICE_TOKEN from shared volume if not set in environment
if [ -z "${VOICE_TOKEN:-}" ] && [ -f /home/ubuntu/.voice-token ]; then
    VOICE_TOKEN=$(cat /home/ubuntu/.voice-token | head -1)
    export VOICE_TOKEN
    echo "[ok] Discovered VOICE_TOKEN from .voice-token"
fi

# Write voice URL for tests
echo "http://hub:3000?token=${VOICE_TOKEN}" > /tmp/voice-url.txt

# Run tests
cd /opt/tests
echo ""
echo "=== Running tests ==="
echo ""
exec npx playwright test "$@"
