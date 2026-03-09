#!/bin/bash
# restart-overseer.sh — Start the overseer agent in the overseer tmux session.
#
# Called by: entrypoint-overseer.sh on boot.
# Restarts happen via docker-compose (container restart), not this script.
#
# Usage:
#   restart-overseer.sh <claude|codex>
#
# Environment:
#   OVERSEER_TMUX_SOCKET  Path to the overseer's tmux socket.

set -euo pipefail

OVERSEER="${1:-}"

if [ "$OVERSEER" != "claude" ] && [ "$OVERSEER" != "codex" ]; then
    echo "ERROR: First argument must be 'claude' or 'codex' (got '${OVERSEER}')"
    exit 1
fi

echo "[restart-overseer] Overseer type: $OVERSEER"

# ---------------------------------------------------------------------------
# Build tmux command prefix for overseer socket
# ---------------------------------------------------------------------------
TMUX_OPTS=()
if [ -n "${OVERSEER_TMUX_SOCKET:-}" ]; then
    TMUX_OPTS=("-S" "$OVERSEER_TMUX_SOCKET")
    echo "[restart-overseer] Using overseer socket: $OVERSEER_TMUX_SOCKET"
fi

# ---------------------------------------------------------------------------
# Source ~/env for API keys
# ---------------------------------------------------------------------------
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
    echo "[restart-overseer] Sourced ~/env"
fi

# ---------------------------------------------------------------------------
# Check if overseer tmux session exists
# ---------------------------------------------------------------------------
if ! tmux "${TMUX_OPTS[@]}" has-session -t overseer 2>/dev/null; then
    echo "ERROR: tmux session 'overseer' not found."
    exit 1
fi

# ---------------------------------------------------------------------------
# Build the startup command
# ---------------------------------------------------------------------------
STARTUP_PROMPT="Run startup recovery: use list-workers and capture-worker-output to check for surviving workers from a previous session. For each one, report its status. Then say you are ready."

if [ "$OVERSEER" = "claude" ]; then
    CMD="claude --dangerously-skip-permissions \"$STARTUP_PROMPT\""
else
    CMD="codex --dangerously-bypass-approvals-and-sandbox \"$STARTUP_PROMPT\""
fi

# ---------------------------------------------------------------------------
# Launch overseer
# ---------------------------------------------------------------------------
echo "[restart-overseer] Launching: $CMD"

# Ensure we're in the overseer working directory and have env vars.
# Unset TMUX so the overseer CLI doesn't think it's already inside tmux.
tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 "cd /opt/squad/overseer && unset TMUX && { [ -f /home/ubuntu/env ] && set -a && . /home/ubuntu/env && set +a || true; } && $CMD" Enter

# ---------------------------------------------------------------------------
# Auto-accept trust/setup dialogs (Claude only)
# ---------------------------------------------------------------------------
if [ "$OVERSEER" = "claude" ]; then
    echo "[restart-overseer] Waiting for Claude to start (handling dialogs)..."
    for i in $(seq 1 30); do
        sleep 2

        PANE_TEXT=$(tmux "${TMUX_OPTS[@]}" capture-pane -t overseer:0 -p -S -30 2>/dev/null | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' || true)

        # Setup dialogs (text style, getting started)
        if echo "$PANE_TEXT" | grep -q "Choose the text style\|Let's get started"; then
            echo "[restart-overseer] Handling setup dialog..."
            tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 Enter
            continue
        fi

        # Trust dialog: "Yes, I accept" + "Enter to confirm"
        if echo "$PANE_TEXT" | grep -q "Yes, I accept"; then
            # Check if claude exited at trust prompt (no child process)
            SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t overseer:0 -F '#{pane_pid}' 2>/dev/null || echo "")
            CHILD_PID=""
            [ -n "$SHELL_PID" ] && CHILD_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ' || true)

            if [ -z "$CHILD_PID" ]; then
                echo "[restart-overseer] Claude exited at trust prompt, accepting and restarting..."
                tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 Enter
                sleep 1
                tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 "unset TMUX && $CMD" Enter
                continue
            fi

            if echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
                echo "[restart-overseer] Accepting trust dialog..."
                tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 2
                sleep 0.5
                tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 Enter
                sleep 2
                continue
            fi
        fi

        # Other "Enter to confirm" dialogs
        if echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
            echo "[restart-overseer] Accepting dialog..."
            tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 Enter
            continue
        fi

        # Check if overseer process is running and past dialogs
        SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t overseer:0 -F '#{pane_pid}' 2>/dev/null || echo "")
        if [ -n "$SHELL_PID" ]; then
            CHILD_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ' || true)
            if [ -n "$CHILD_PID" ] && ! echo "$PANE_TEXT" | grep -q "Enter to confirm"; then
                CHILD_CMD=$(ps -o comm= -p "$CHILD_PID" 2>/dev/null || echo "unknown")
                echo "[restart-overseer] Overseer running: PID $CHILD_PID ($CHILD_CMD)"
                break
            fi
        fi
    done
else
    # Codex: simple wait and verify
    echo "[restart-overseer] Waiting 5s for overseer to start..."
    sleep 5
    SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t overseer:0 -F '#{pane_pid}' 2>/dev/null || echo "")
    if [ -n "$SHELL_PID" ]; then
        NEW_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
        if [ -n "$NEW_PID" ]; then
            echo "[restart-overseer] Overseer running: PID $NEW_PID"
        else
            echo "[restart-overseer] WARNING: No overseer process detected yet — it may still be starting."
        fi
    fi
fi

echo "[restart-overseer] Done."
