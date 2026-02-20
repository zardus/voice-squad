#!/bin/bash
# restart-captain.sh — Start the captain agent in the captain tmux session.
#
# Called by: entrypoint-captain.sh on boot.
# Restarts happen via docker-compose (container restart), not this script.
#
# Usage:
#   restart-captain.sh <claude|codex>
#
# Environment:
#   CAPTAIN_TMUX_SOCKET  Path to the captain's tmux socket.

set -euo pipefail

CAPTAIN="${1:-}"

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "ERROR: First argument must be 'claude' or 'codex' (got '${CAPTAIN}')"
    exit 1
fi

echo "[restart-captain] Captain type: $CAPTAIN"

# ---------------------------------------------------------------------------
# Build tmux command prefix for captain socket
# ---------------------------------------------------------------------------
TMUX_OPTS=()
if [ -n "${CAPTAIN_TMUX_SOCKET:-}" ]; then
    TMUX_OPTS=("-S" "$CAPTAIN_TMUX_SOCKET")
    echo "[restart-captain] Using captain socket: $CAPTAIN_TMUX_SOCKET"
fi

# ---------------------------------------------------------------------------
# Source ~/env for API keys
# ---------------------------------------------------------------------------
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
    echo "[restart-captain] Sourced ~/env"
fi

# ---------------------------------------------------------------------------
# Check if captain tmux session exists
# ---------------------------------------------------------------------------
if ! tmux "${TMUX_OPTS[@]}" has-session -t captain 2>/dev/null; then
    echo "ERROR: tmux session 'captain' not found."
    exit 1
fi

# ---------------------------------------------------------------------------
# Build the startup command
# ---------------------------------------------------------------------------
STARTUP_PROMPT="Run startup recovery: use list-workers and capture-worker-output to check for surviving workers from a previous session. For each one, report its status. Then say you are ready for instructions."

if [ "$CAPTAIN" = "claude" ]; then
    CMD="claude --dangerously-skip-permissions \"$STARTUP_PROMPT\""
else
    CMD="codex --dangerously-bypass-approvals-and-sandbox \"$STARTUP_PROMPT\""
fi

# ---------------------------------------------------------------------------
# Launch captain
# ---------------------------------------------------------------------------
echo "[restart-captain] Launching: $CMD"

# Ensure we're in the captain working directory and have env vars.
# Unset TMUX so the captain CLI doesn't think it's already inside tmux.
tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 "cd /opt/squad/captain && unset TMUX && { [ -f /home/ubuntu/env ] && set -a && . /home/ubuntu/env && set +a || true; } && $CMD" Enter

# ---------------------------------------------------------------------------
# Auto-accept trust/setup dialogs (Claude only)
# ---------------------------------------------------------------------------
if [ "$CAPTAIN" = "claude" ]; then
    echo "[restart-captain] Waiting for Claude to start (handling dialogs)..."
    for i in $(seq 1 30); do
        sleep 2

        PANE_TEXT=$(tmux "${TMUX_OPTS[@]}" capture-pane -t captain:0 -p -S -30 2>/dev/null | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' || true)

        # Setup dialogs (text style, getting started)
        if echo "$PANE_TEXT" | grep -q "Choose the text style\|Let's get started"; then
            echo "[restart-captain] Handling setup dialog..."
            tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 Enter
            continue
        fi

        # Trust dialog: "Yes, I accept" + "Enter to confirm"
        if echo "$PANE_TEXT" | grep -q "Yes, I accept"; then
            # Check if claude exited at trust prompt (no child process)
            SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t captain:0 -F '#{pane_pid}' 2>/dev/null || echo "")
            CHILD_PID=""
            [ -n "$SHELL_PID" ] && CHILD_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ' || true)

            if [ -z "$CHILD_PID" ]; then
                echo "[restart-captain] Claude exited at trust prompt, accepting and restarting..."
                tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 Enter
                sleep 1
                tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 "unset TMUX && $CMD" Enter
                continue
            fi

            if echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
                echo "[restart-captain] Accepting trust dialog..."
                tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 2
                sleep 0.5
                tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 Enter
                sleep 2
                continue
            fi
        fi

        # Other "Enter to confirm" dialogs
        if echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
            echo "[restart-captain] Accepting dialog..."
            tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 Enter
            continue
        fi

        # Check if captain process is running and past dialogs
        SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t captain:0 -F '#{pane_pid}' 2>/dev/null || echo "")
        if [ -n "$SHELL_PID" ]; then
            CHILD_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ' || true)
            if [ -n "$CHILD_PID" ] && ! echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
                CHILD_CMD=$(ps -o comm= -p "$CHILD_PID" 2>/dev/null || echo "unknown")
                echo "[restart-captain] Captain running: PID $CHILD_PID ($CHILD_CMD)"
                break
            fi
        fi
    done
else
    # Codex: simple wait and verify
    echo "[restart-captain] Waiting 5s for captain to start..."
    sleep 5
    SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t captain:0 -F '#{pane_pid}' 2>/dev/null || echo "")
    if [ -n "$SHELL_PID" ]; then
        NEW_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
        if [ -n "$NEW_PID" ]; then
            echo "[restart-captain] Captain running: PID $NEW_PID"
        else
            echo "[restart-captain] WARNING: No captain process detected yet — it may still be starting."
        fi
    fi
fi

echo "[restart-captain] Done."
