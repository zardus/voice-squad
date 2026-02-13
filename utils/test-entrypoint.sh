#!/usr/bin/env bash
# Test-container entrypoint: starts tmux + voice server, then runs the full
# Playwright suite (including integration tests).
set -euo pipefail

# ── Generate auth token ──────────────────────────────────────
export VOICE_TOKEN
VOICE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

# Dummy API keys — no tests call external APIs, but the voice server
# requires OPENAI_API_KEY to start.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-test-dummy}"

# Isolated captain filesystem for tests (avoid relying on /home/ubuntu/captain defaults).
export SQUAD_CAPTAIN_DIR=/tmp/test-captain
export SQUAD_SUMMARIES_DIR=/tmp/test-captain/archive/summaries
rm -rf "$SQUAD_CAPTAIN_DIR"
mkdir -p "$SQUAD_SUMMARIES_DIR" "$SQUAD_CAPTAIN_DIR/task-definitions/pending" "$SQUAD_CAPTAIN_DIR/task-definitions/archived"

# ── Start tmux session (bare shell acts as the "captain") ────
tmux new-session -d -s captain -c /home/ubuntu

# ── Start voice server ───────────────────────────────────────
node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1 &
VOICE_PID=$!

echo "Waiting for voice server on :3000..."
for i in $(seq 1 20); do
    if ! kill -0 "$VOICE_PID" 2>/dev/null; then
        echo "ERROR: Voice server crashed!"
        cat /tmp/voice-server.log 2>/dev/null || true
        exit 1
    fi
    if grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then break; fi
    sleep 0.5
done

if ! grep -q 'listening on' /tmp/voice-server.log 2>/dev/null; then
    echo "ERROR: Voice server not ready after 10s"
    cat /tmp/voice-server.log 2>/dev/null || true
    exit 1
fi
echo "[ok] Voice server is running"

# Write voice URL so test helpers can discover the token
echo "http://localhost:3000?token=${VOICE_TOKEN}" > /tmp/voice-url.txt

# ── Run tests ────────────────────────────────────────────────
cd /opt/tests
export TEST_INTEGRATION=1
echo ""
echo "=== Running all tests (including integration) ==="
echo ""
npx playwright test "$@"
