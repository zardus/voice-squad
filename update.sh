#!/bin/bash
# update.sh — Hot-update a running squad container from the latest git code
#
# Runs INSIDE the Docker container where this repo is already cloned.
#
# Steps:
#   1. git pull latest code
#   2. Copy updated source files to installed locations (/opt/squad/)
#   3. Reinstall npm dependencies if package.json changed
#   4. Restart the voice server and status daemon
#
# RESTARTED:
#   - Voice server (node /opt/squad/voice/server.js)
#   - Status daemon (node /opt/squad/voice/status-daemon.js)
#
# KEPT ALIVE (untouched):
#   - cloudflared tunnel  — keeps the *.trycloudflare.com URL stable
#   - Docker daemon       — dockerd (for Docker-in-Docker)
#   - tmux session        — all windows/panes preserved
#   - Captain agent       — unless --restart-captain is passed
#
# Usage:
#   ./update.sh                      # update code + restart voice server only
#   ./update.sh --restart-captain    # also restart the captain agent (LAST step)

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
RESTART_CAPTAIN=false
for arg in "$@"; do
    case "$arg" in
        --restart-captain) RESTART_CAPTAIN=true ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

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
echo "==> Killing status daemon (if running)..."
DAEMON_PID=$(pgrep -f "node /opt/squad/voice/status-daemon.js" | head -1 || true)
if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    sleep 0.5
    echo "    Status daemon stopped (was PID $DAEMON_PID)."
else
    echo "    No running status daemon found."
fi

echo "==> Restarting voice server..."

# Find the running voice server PID (if any)
VOICE_PID=$(pgrep -f "node /opt/squad/voice/server.js" | head -1 || true)

# If this script was spawned by the voice server (via /api/update), killing the
# server closes the read end of our stdout pipe. The next echo would then get
# SIGPIPE and kill the script before the new server starts. Redirect our output
# to a log file so we're writing to a file, not a pipe.
exec > /tmp/update.log 2>&1

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
    if [ -f /home/ubuntu/env ]; then set -a; . /home/ubuntu/env; set +a; fi
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

# Launch status daemon in the background
echo "==> Starting status daemon..."
ANTHROPIC_API_KEY="${_ANT_KEY}" \
    node /opt/squad/voice/status-daemon.js > /tmp/status-daemon.log 2>&1 &
NEW_DAEMON_PID=$!
sleep 1
if kill -0 "$NEW_DAEMON_PID" 2>/dev/null; then
    echo "    Status daemon running (PID $NEW_DAEMON_PID)."
else
    echo "    WARNING: Status daemon failed to start. Check /tmp/status-daemon.log"
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
# 6. Restart captain (only if --restart-captain was passed)
#
#    THIS IS THE LAST STEP. Everything above must succeed first.
#    The captain is the orchestrator — if this fails, manual recovery is needed.
#    We kill the old captain process and launch a new one in the same tmux window.
# ---------------------------------------------------------------------------
if [ "$RESTART_CAPTAIN" = true ]; then
    echo "==> Restarting captain agent (--restart-captain requested)..."

    # Safety check 1: tmux session must exist
    if ! tmux has-session -t captain 2>/dev/null; then
        echo "    ERROR: tmux session 'captain' not found! Cannot restart captain."
        echo "    Manual intervention required."
        exit 1
    fi
    echo "    [check] tmux session 'captain' exists."

    # Safety check 2: captain instructions must be in place
    CAPTAIN="${SQUAD_CAPTAIN:-claude}"
    if [ "$CAPTAIN" = "claude" ]; then
        INSTRUCTIONS_FILE="/home/ubuntu/captain/CLAUDE.md"
    else
        INSTRUCTIONS_FILE="/home/ubuntu/captain/AGENTS.md"
    fi
    if [ ! -f "$INSTRUCTIONS_FILE" ]; then
        echo "    ERROR: Captain instructions not found at $INSTRUCTIONS_FILE!"
        echo "    Files were not copied correctly. Aborting captain restart."
        exit 1
    fi
    echo "    [check] Captain instructions in place ($INSTRUCTIONS_FILE)."

    # Safety check 3: MCP config must be in place
    if [ ! -f /home/ubuntu/.squad-mcp.json ]; then
        echo "    ERROR: MCP config not found at /home/ubuntu/.squad-mcp.json!"
        exit 1
    fi
    echo "    [check] MCP config in place."

    # Safety check 4: voice server must be running (we just restarted it above)
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
        echo "    ERROR: Voice server (PID $NEW_PID) is not running!"
        echo "    Refusing to restart captain without a healthy voice server."
        exit 1
    fi
    echo "    [check] Voice server healthy (PID $NEW_PID)."

    # All checks passed — find and kill the old captain process directly.
    # The process hierarchy in captain:0 is: bash (shell) -> claude/codex (captain)
    # We get the shell PID from tmux, find its child captain process, and kill it.

    # Get the shell PID running in captain:0
    SHELL_PID=$(tmux list-panes -t captain:0 -F '#{pane_pid}')
    echo "    Shell PID in captain:0: $SHELL_PID"

    # Find the captain child process (claude or codex) directly under the shell
    CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')

    if [ -n "$CAPTAIN_PID" ]; then
        CAPTAIN_CMD=$(ps -o comm= -p "$CAPTAIN_PID" 2>/dev/null || echo "unknown")
        echo "    Found captain process: PID $CAPTAIN_PID ($CAPTAIN_CMD)"
        echo "    Sending SIGTERM..."

        # Kill the entire process group (captain + its children like tmux-mcp)
        kill -- -"$CAPTAIN_PID" 2>/dev/null || kill "$CAPTAIN_PID" 2>/dev/null || true

        # Wait up to 5s for the process to die
        for i in $(seq 1 10); do
            if ! kill -0 "$CAPTAIN_PID" 2>/dev/null; then
                echo "    Captain exited after SIGTERM (${i}x0.5s)."
                break
            fi
            sleep 0.5
        done

        # Force kill if still alive
        if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
            echo "    Still alive after 5s — sending SIGKILL..."
            kill -9 -- -"$CAPTAIN_PID" 2>/dev/null || kill -9 "$CAPTAIN_PID" 2>/dev/null || true
            sleep 1
            if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
                echo "    ERROR: Captain process $CAPTAIN_PID refuses to die!"
                exit 1
            fi
            echo "    Captain killed with SIGKILL."
        fi
    else
        echo "    No captain process found under shell PID $SHELL_PID — proceeding anyway."
    fi

    # Wait a beat for the shell to settle after its child exits
    sleep 1

    # Clear any leftover text in the tmux pane input line, then launch
    tmux send-keys -t captain:0 C-c
    sleep 0.5

    # Launch new captain in the same window (mirrors launch-squad.sh)
    echo "    Launching new captain ($CAPTAIN)..."
    if [ "$CAPTAIN" = "claude" ]; then
        tmux send-keys -t captain:0 "claude --dangerously-skip-permissions --mcp-config /home/ubuntu/.squad-mcp.json" Enter
    else
        tmux send-keys -t captain:0 "codex --dangerously-bypass-approvals-and-sandbox" Enter
    fi

    # Verify the new captain process started
    sleep 3
    NEW_CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
    if [ -n "$NEW_CAPTAIN_PID" ]; then
        NEW_CAPTAIN_CMD=$(ps -o comm= -p "$NEW_CAPTAIN_PID" 2>/dev/null || echo "unknown")
        echo "    New captain running: PID $NEW_CAPTAIN_PID ($NEW_CAPTAIN_CMD)"
    else
        echo "    WARNING: No captain process detected yet — it may still be starting."
    fi

    CAPTAIN_RESTARTED=true
else
    CAPTAIN_RESTARTED=false
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Update complete ==="
echo "  Voice server:  restarted (PID $NEW_PID)"
echo "  Status daemon: restarted (PID $NEW_DAEMON_PID)"
echo "  Tunnel:        kept alive"
if [ "$CAPTAIN_RESTARTED" = true ]; then
    echo "  Captain:       RESTARTED (tmux captain:0)"
else
    echo "  Captain:       kept alive (tmux captain:0)"
fi
echo "  Voice URL:     $(cat /tmp/voice-url.txt 2>/dev/null || echo 'unknown')"
echo "  Voice log:     /tmp/voice-server.log"
