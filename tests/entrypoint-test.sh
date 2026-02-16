#!/usr/bin/env bash
# Test-runner entrypoint: waits for infrastructure, then runs Playwright.
set -euo pipefail

# Ensure tmux socket dirs are accessible
sudo mkdir -p /run/captain-tmux /run/workspace-tmux 2>/dev/null || true
sudo chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux 2>/dev/null || true
sudo chmod 755 /run/captain-tmux /run/workspace-tmux 2>/dev/null || true

# Wait for captain tmux session (started by captain container)
echo "Waiting for captain tmux session..."
timeout=30
while ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux -S "$CAPTAIN_TMUX_SOCKET" has-session -t captain 2>/dev/null; then
    echo "ERROR: captain tmux session not available after 30s"
    exit 1
fi
echo "[ok] captain tmux session found"

# Discover VOICE_TOKEN from shared volume if not set in environment
if [ -z "${VOICE_TOKEN:-}" ] && [ -f /home/ubuntu/.voice-token ]; then
    VOICE_TOKEN=$(cat /home/ubuntu/.voice-token | head -1)
    export VOICE_TOKEN
    echo "[ok] Discovered VOICE_TOKEN from .voice-token"
fi

# Write voice URL for tests
echo "http://localhost:3000?token=${VOICE_TOKEN}" > /tmp/voice-url.txt

# Run tests
cd /opt/tests
echo ""
echo "=== Running tests ==="
echo ""
exec npx playwright test "$@"
