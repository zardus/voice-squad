#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Parse flags ──────────────────────────────────────────────
RUN_INTEGRATION=0
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --integration|--all)
      RUN_INTEGRATION=1
      ;;
    *)
      EXTRA_ARGS+=("$arg")
      ;;
  esac
done

# ── Pre-flight checks ───────────────────────────────────────
echo "=== Voice-Squad Test Suite ==="
echo ""

# Check if server is running
if ! curl -sf http://localhost:3000 > /dev/null 2>&1; then
  echo "ERROR: Voice server not running on localhost:3000"
  echo "Start the container first with: ./run.sh"
  exit 1
fi
echo "[ok] Voice server is running on port 3000"

# Discover token
export VOICE_TOKEN="${VOICE_TOKEN:-}"
if [ -z "$VOICE_TOKEN" ] && [ -f /tmp/voice-url.txt ]; then
  VOICE_TOKEN=$(grep -oP 'token=\K[^&\s]+' /tmp/voice-url.txt 2>/dev/null || true)
fi
if [ -z "$VOICE_TOKEN" ]; then
  # Try from process environ
  PID=$(pgrep -f 'node.*server\.js' | head -1 || true)
  if [ -n "$PID" ] && [ -f "/proc/$PID/environ" ]; then
    VOICE_TOKEN=$(tr '\0' '\n' < "/proc/$PID/environ" | grep '^VOICE_TOKEN=' | cut -d= -f2- || true)
  fi
fi
if [ -z "$VOICE_TOKEN" ]; then
  echo "ERROR: Cannot discover VOICE_TOKEN"
  echo "Set VOICE_TOKEN env var or ensure /tmp/voice-url.txt exists"
  exit 1
fi
export VOICE_TOKEN
echo "[ok] Token discovered (${VOICE_TOKEN:0:8}...)"

# Install dependencies if needed
if [ ! -d node_modules/@playwright ]; then
  echo ""
  echo "Installing test dependencies..."
  npm install
fi

# Check if Chromium is installed
if ! npx playwright install --dry-run chromium 2>/dev/null | grep -q "already"; then
  echo ""
  echo "Installing Playwright Chromium..."
  npx playwright install --with-deps chromium
fi

echo ""

# ── Run tests ────────────────────────────────────────────────
if [ "$RUN_INTEGRATION" -eq 1 ]; then
  echo "Running ALL tests (including integration)..."
  export TEST_INTEGRATION=1
else
  echo "Running tests (skipping integration; use --integration or --all to include)..."
fi
echo ""

npx playwright test "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

echo ""
echo "=== Tests complete ==="
