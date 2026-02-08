#!/bin/bash
# update.sh — Hot-update a running squad container from the latest git code
#
# Runs INSIDE the Docker container where this repo is already cloned.
#
# Steps:
#   1. git pull latest code
#   2. Copy updated source files to installed locations (/opt/squad/)
#   3. Reinstall npm dependencies if package.json changed
#   4. Restart ONLY the voice server process
#
# RESTARTED:
#   - Voice server (node /opt/squad/voice/server.js)
#
# KEPT ALIVE (untouched):
#   - cloudflared tunnel  — keeps the *.trycloudflare.com URL stable
#   - Captain agent       — claude/codex CLI in tmux session captain:0
#   - Docker daemon       — dockerd (for Docker-in-Docker)
#   - tmux session        — all windows/panes preserved
#
# Usage:
#   ./update.sh              # from the repo root
#   /path/to/update.sh       # from anywhere (locates repo via its own path)

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root (the directory this script lives in)
# ---------------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> Repo: $REPO_DIR"

# ---------------------------------------------------------------------------
# 1. Pull latest code
# ---------------------------------------------------------------------------
echo "==> Pulling latest code..."
git -C "$REPO_DIR" pull --ff-only
echo ""

# ---------------------------------------------------------------------------
# 2. Copy updated files to /opt/squad/ (the installed location)
#
#    At build time, the Dockerfile copies src/ files to /opt/squad/ and runs
#    npm install there. At runtime, launch-squad.sh copies some files from
#    /opt/squad/ to /home/ubuntu/ (captain instructions, MCP configs).
#    We replicate both layers here.
# ---------------------------------------------------------------------------
echo "==> Updating installed files..."

# Snapshot the current package.json hash BEFORE overwriting, so we can detect changes
OLD_PKG_HASH=$(md5sum /opt/squad/voice/package.json 2>/dev/null | cut -d' ' -f1 || echo "none")

# --- Voice server source files (*.js, *.json — node_modules left untouched) ---
sudo cp "$REPO_DIR"/src/voice/*.js /opt/squad/voice/
sudo cp "$REPO_DIR"/src/voice/*.json /opt/squad/voice/

# --- Voice PWA frontend (clean replace to remove stale assets) ---
sudo rm -rf /opt/squad/voice/public
sudo cp -r "$REPO_DIR"/src/voice/public /opt/squad/voice/public

# --- Captain instructions + configs ---
sudo cp "$REPO_DIR/src/captain-instructions.md" /opt/squad/captain/instructions.md
sudo cp "$REPO_DIR/src/mcp-config.json"         /opt/squad/mcp-config.json
sudo cp "$REPO_DIR/src/codex-mcp-config.toml"   /opt/squad/codex-mcp-config.toml

# --- Startup scripts (take effect on next container start only) ---
sudo cp "$REPO_DIR/src/launch-squad.sh" /opt/squad/launch-squad.sh
sudo chmod +x /opt/squad/launch-squad.sh
sudo cp "$REPO_DIR/src/entrypoint.sh" /entrypoint.sh
sudo chmod +x /entrypoint.sh

# --- Update runtime copies in the persistent volume ---
#     (mirrors what launch-squad.sh does at boot)
CAPTAIN="${SQUAD_CAPTAIN:-claude}"
mkdir -p /home/ubuntu/captain
if [ "$CAPTAIN" = "claude" ]; then
    cp /opt/squad/captain/instructions.md /home/ubuntu/captain/CLAUDE.md
else
    cp /opt/squad/captain/instructions.md /home/ubuntu/captain/AGENTS.md
fi
cp /opt/squad/mcp-config.json /home/ubuntu/.squad-mcp.json
mkdir -p /home/ubuntu/.codex
cp /opt/squad/codex-mcp-config.toml /home/ubuntu/.codex/config.toml

echo "    Files copied."

# ---------------------------------------------------------------------------
# 3. Reinstall npm dependencies if package.json changed
# ---------------------------------------------------------------------------
NEW_PKG_HASH=$(md5sum /opt/squad/voice/package.json | cut -d' ' -f1)

if [ "$OLD_PKG_HASH" != "$NEW_PKG_HASH" ]; then
    echo "==> package.json changed — running npm install..."
    (cd /opt/squad/voice && sudo npm install --production)
    echo "    Dependencies updated."
else
    echo "==> package.json unchanged — skipping npm install."
fi

# ---------------------------------------------------------------------------
# 4. Restart ONLY the voice server
#
#    The voice server was originally started in launch-squad.sh as:
#      OPENAI_API_KEY=... ANTHROPIC_API_KEY=... node /opt/squad/voice/server.js &
#
#    We capture its environment from /proc before killing it, then relaunch
#    with the same env vars. The cloudflared tunnel is a separate process
#    pointing at localhost:3000 — it stays alive and reconnects automatically
#    when the voice server comes back up on the same port.
# ---------------------------------------------------------------------------
echo "==> Restarting voice server..."

# Find the running voice server PID (if any)
VOICE_PID=$(pgrep -f "node /opt/squad/voice/server.js" | head -1 || true)

if [ -n "$VOICE_PID" ]; then
    # Extract env vars from the running process before killing it.
    # /proc/<pid>/environ is null-delimited; convert to newlines, then
    # use sed to extract specific vars (sed returns 0 even on no match,
    # avoiding issues with set -eo pipefail).
    PROC_ENV=$(tr '\0' '\n' < /proc/"$VOICE_PID"/environ 2>/dev/null || true)
    _OAI_KEY=$(echo "$PROC_ENV"  | sed -n 's/^OPENAI_API_KEY=//p'    | head -1)
    _ANT_KEY=$(echo "$PROC_ENV"  | sed -n 's/^ANTHROPIC_API_KEY=//p'  | head -1)
    _V_TOKEN=$(echo "$PROC_ENV"  | sed -n 's/^VOICE_TOKEN=//p'        | head -1)
    _S_CAPTAIN=$(echo "$PROC_ENV" | sed -n 's/^SQUAD_CAPTAIN=//p'     | head -1)

    # Graceful shutdown
    echo "    Stopping voice server (PID $VOICE_PID)..."
    kill "$VOICE_PID" 2>/dev/null || true

    # Wait up to 5s for clean exit
    for _ in $(seq 1 10); do
        kill -0 "$VOICE_PID" 2>/dev/null || break
        sleep 0.5
    done

    # Force kill if it didn't exit cleanly
    if kill -0 "$VOICE_PID" 2>/dev/null; then
        echo "    Force-killing voice server..."
        kill -9 "$VOICE_PID" 2>/dev/null || true
        sleep 0.5
    fi
    echo "    Voice server stopped."
else
    echo "    No running voice server found — starting fresh."
    # Fall back: source env file (same mechanism launch-squad.sh uses)
    # shellcheck disable=SC1091
    [ -f /home/ubuntu/env ] && . /home/ubuntu/env || true
    _OAI_KEY="${_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
    _ANT_KEY="${_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"
    _V_TOKEN="${VOICE_TOKEN:-}"
    _S_CAPTAIN="${SQUAD_CAPTAIN:-claude}"
fi

# Launch voice server with the same environment.
# Output goes to the same log file that the tmux voice window tails.
OPENAI_API_KEY="${_OAI_KEY}" \
ANTHROPIC_API_KEY="${_ANT_KEY}" \
VOICE_TOKEN="${_V_TOKEN}" \
SQUAD_CAPTAIN="${_S_CAPTAIN}" \
    node /opt/squad/voice/server.js > /tmp/voice-server.log 2>&1 &

NEW_PID=$!

# Quick health check — give it a second to initialize
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "    Voice server running (PID $NEW_PID)."
else
    echo "    ERROR: Voice server failed to start! Check /tmp/voice-server.log:"
    tail -10 /tmp/voice-server.log 2>/dev/null || true
    exit 1
fi

# ---------------------------------------------------------------------------
# 5. Verify other processes are still alive
# ---------------------------------------------------------------------------
if pgrep -f "cloudflared tunnel" > /dev/null 2>&1; then
    echo "==> cloudflared tunnel: running (untouched)."
else
    echo "==> WARNING: cloudflared tunnel is not running!"
fi

if tmux has-session -t captain 2>/dev/null; then
    echo "==> Captain tmux session: alive."
else
    echo "==> WARNING: Captain tmux session not found!"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Update complete ==="
echo "  Voice server:  restarted (PID $NEW_PID)"
echo "  Tunnel:        kept alive"
echo "  Captain:       kept alive (tmux captain:0)"
echo "  Voice URL:     $(cat /tmp/voice-url.txt 2>/dev/null || echo 'unknown')"
echo "  Voice log:     /tmp/voice-server.log"
