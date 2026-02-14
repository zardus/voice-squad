#!/usr/bin/env bash
# Test-runner entrypoint: waits for infrastructure, then runs Playwright.
set -euo pipefail

# Ensure tmux socket is accessible
sudo mkdir -p /run/tmux 2>/dev/null || true
sudo chown ubuntu:ubuntu /run/tmux 2>/dev/null || true
sudo chmod 755 /run/tmux 2>/dev/null || true

# Wait for tmux captain session (started by workspace container)
echo "Waiting for tmux captain session..."
timeout=30
while ! tmux has-session -t captain 2>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if ! tmux has-session -t captain 2>/dev/null; then
    echo "ERROR: tmux captain session not available after 30s"
    exit 1
fi
echo "[ok] tmux captain session found"

# Write voice URL for main-menu.spec.js (reads /tmp/voice-url.txt)
echo "http://localhost:3000?token=${VOICE_TOKEN}" > /tmp/voice-url.txt

# Run tests
cd /opt/tests
echo ""
echo "=== Running tests ==="
echo ""
exec npx playwright test "$@"
