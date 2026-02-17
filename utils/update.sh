#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Parse flags ──────────────────────────────────────────────
RESTART_CAPTAIN=0
for arg in "$@"; do
  case "$arg" in
    --restart-captain) RESTART_CAPTAIN=1 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Find voice-server container ──────────────────────────────
VOICE_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=voice-server" --format '{{.Names}}' | head -1)
if [ -z "$VOICE_CONTAINER" ]; then
  echo "ERROR: voice-server container not found. Is the stack running?"
  exit 1
fi
echo "[update] voice-server container: $VOICE_CONTAINER"

# ── Pull latest git ──────────────────────────────────────────
echo "[update] pulling latest git..."
git pull --ff-only 2>/dev/null || echo "[update] git pull skipped (not on a tracking branch or no remote)"

# ── Copy voice-server files ──────────────────────────────────
echo "[update] copying src/voice-server/ -> $VOICE_CONTAINER:/opt/squad/voice/"
docker cp src/voice-server/server.js       "$VOICE_CONTAINER":/opt/squad/voice/server.js
docker cp src/voice-server/tmux-bridge.js  "$VOICE_CONTAINER":/opt/squad/voice/tmux-bridge.js
docker cp src/voice-server/stt.js          "$VOICE_CONTAINER":/opt/squad/voice/stt.js
docker cp src/voice-server/tts.js          "$VOICE_CONTAINER":/opt/squad/voice/tts.js
docker cp src/voice-server/status-daemon.js "$VOICE_CONTAINER":/opt/squad/voice/status-daemon.js
docker cp src/voice-server/public/         "$VOICE_CONTAINER":/opt/squad/voice/public/
echo "[update] voice-server files copied"

# ── Copy pane-monitor if present ─────────────────────────────
PANE_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=pane-monitor" --format '{{.Names}}' | head -1)
if [ -n "$PANE_CONTAINER" ] && [ -f src/pane-monitor/pane-monitor.sh ]; then
  echo "[update] copying pane-monitor.sh -> $PANE_CONTAINER:/opt/squad/pane-monitor.sh"
  docker cp src/pane-monitor/pane-monitor.sh "$PANE_CONTAINER":/opt/squad/pane-monitor.sh
fi

# ── Restart voice server process ─────────────────────────────
echo "[update] restarting voice server..."
# Kill existing node process; use docker exec -d to avoid blocking if the
# container's PID 1 is affected.
docker exec "$VOICE_CONTAINER" pkill -f "node /opt/squad/voice/server.js" 2>/dev/null || true
sleep 2
# Start the new voice server in the background (detached exec).
docker exec -d "$VOICE_CONTAINER" bash -c 'node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1'
# Wait for it to be listening.
for i in $(seq 1 20); do
  if docker exec "$VOICE_CONTAINER" grep -q "listening on" /tmp/voice-server.log 2>/dev/null; then
    echo "[update] voice server listening"
    break
  fi
  sleep 0.5
done
if ! docker exec "$VOICE_CONTAINER" grep -q "listening on" /tmp/voice-server.log 2>/dev/null; then
  echo "[update] WARNING: voice server may not have started"
  docker exec "$VOICE_CONTAINER" tail -10 /tmp/voice-server.log 2>/dev/null || true
fi
echo "[update] voice server restarted"

# ── Optionally restart captain ───────────────────────────────
if [ "$RESTART_CAPTAIN" -eq 1 ]; then
  CAPTAIN_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=captain" --format '{{.Names}}' | head -1)
  if [ -n "$CAPTAIN_CONTAINER" ]; then
    echo "[update] restarting captain container..."
    docker restart "$CAPTAIN_CONTAINER"
    echo "[update] captain restarted"
  else
    echo "[update] WARNING: captain container not found"
  fi
fi

echo "[update] done"
