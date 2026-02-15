#!/bin/bash
# restart-captain.sh — Unified script to kill and restart the captain agent
#
# Called by: launch-squad.sh, update.sh --restart-captain, web UI /api/restart-captain
#
# Usage:
#   restart-captain.sh <claude|codex> [--fresh]
#
# Options:
#   --fresh   Skip --continue/resume and start with the startup recovery prompt instead.
#             Used by launch-squad.sh on first boot.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
CAPTAIN="${1:-}"
FRESH=false

for arg in "$@"; do
    case "$arg" in
        --fresh) FRESH=true ;;
        claude|codex) ;; # already captured as $1
        *) echo "ERROR: Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ "$CAPTAIN" != "claude" ] && [ "$CAPTAIN" != "codex" ]; then
    echo "ERROR: First argument must be 'claude' or 'codex' (got '${CAPTAIN}')"
    exit 1
fi

echo "[restart-captain] Captain type: $CAPTAIN (fresh=$FRESH)"

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
if ! tmux has-session -t captain 2>/dev/null; then
    echo "ERROR: tmux session 'captain' not found. Cannot restart captain."
    exit 1
fi

# ---------------------------------------------------------------------------
# Kill existing captain (if any) in captain:0
# ---------------------------------------------------------------------------
CODEX_SESSION_ID=""

# Get the shell PID running in captain:0
SHELL_PID=$(tmux list-panes -t captain:0 -F '#{pane_pid}' 2>/dev/null || echo "")

if [ -z "$SHELL_PID" ]; then
    echo "[restart-captain] WARNING: Could not get pane PID for captain:0"
else
    # Check if there's a captain process running under the shell
    CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ' || true)

    if [ -n "$CAPTAIN_PID" ]; then
        CAPTAIN_CMD=$(ps -o comm= -p "$CAPTAIN_PID" 2>/dev/null || echo "unknown")
        echo "[restart-captain] Found captain process: PID $CAPTAIN_PID ($CAPTAIN_CMD)"

        # For codex: capture pane BEFORE killing to find resume session ID
        if [ "$CAPTAIN" = "codex" ] && [ "$FRESH" = false ]; then
            echo "[restart-captain] Capturing codex pane for session ID..."
            PANE_OUTPUT=$(tmux capture-pane -t captain:0 -p -S -200 2>/dev/null || true)
            CODEX_SESSION_ID=$(echo "$PANE_OUTPUT" | grep -oP 'codex resume \K[a-f0-9-]+' | tail -1 || true)
            if [ -n "$CODEX_SESSION_ID" ]; then
                echo "[restart-captain] Found codex session ID (pre-kill): $CODEX_SESSION_ID"
            fi
        fi

        # Kill with Ctrl+C (twice, with waits)
        echo "[restart-captain] Sending Ctrl+C to captain:0..."
        tmux send-keys -t captain:0 C-c
        sleep 1

        tmux send-keys -t captain:0 C-c
        sleep 2

        # Check if process exited
        if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
            echo "[restart-captain] Still running after Ctrl+C, sending third Ctrl+C..."
            tmux send-keys -t captain:0 C-c
            sleep 2
        fi

        # If still alive, escalate to SIGTERM then SIGKILL
        if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
            echo "[restart-captain] Still alive — sending SIGTERM..."
            kill -- -"$CAPTAIN_PID" 2>/dev/null || kill "$CAPTAIN_PID" 2>/dev/null || true
            for _ in $(seq 1 10); do
                kill -0 "$CAPTAIN_PID" 2>/dev/null || break
                sleep 0.5
            done
        fi

        if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
            echo "[restart-captain] Still alive — sending SIGKILL..."
            kill -9 -- -"$CAPTAIN_PID" 2>/dev/null || kill -9 "$CAPTAIN_PID" 2>/dev/null || true
            sleep 1
        fi

        # For codex: check pane output AFTER kill for session ID (codex prints it on exit)
        if [ "$CAPTAIN" = "codex" ] && [ "$FRESH" = false ] && [ -z "$CODEX_SESSION_ID" ]; then
            echo "[restart-captain] Checking post-kill pane for codex session ID..."
            PANE_OUTPUT=$(tmux capture-pane -t captain:0 -p -S -200 2>/dev/null || true)
            CODEX_SESSION_ID=$(echo "$PANE_OUTPUT" | grep -oP 'codex resume \K[a-f0-9-]+' | tail -1 || true)
            if [ -n "$CODEX_SESSION_ID" ]; then
                echo "[restart-captain] Found codex session ID (post-kill): $CODEX_SESSION_ID"
            fi
        fi

        if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
            echo "ERROR: Captain process $CAPTAIN_PID refuses to die!"
            exit 1
        fi
        echo "[restart-captain] Captain process killed."
    else
        echo "[restart-captain] No captain process found under shell PID $SHELL_PID — proceeding."
    fi
fi

# Wait for the shell to settle
sleep 1

# Clear any leftover text in the tmux pane input line
tmux send-keys -t captain:0 C-c 2>/dev/null || true
sleep 0.3

# Verify we have a shell prompt (check pane for $ prompt)
PANE_CHECK=$(tmux capture-pane -t captain:0 -p -S -5 2>/dev/null || true)
if echo "$PANE_CHECK" | grep -qE '^\$|ubuntu@|bash.*\$'; then
    echo "[restart-captain] Shell prompt confirmed."
else
    echo "[restart-captain] WARNING: Shell prompt not detected, proceeding anyway."
    echo "[restart-captain] Last lines: $(echo "$PANE_CHECK" | tail -3)"
fi

# ---------------------------------------------------------------------------
# Build the startup command
# ---------------------------------------------------------------------------
STARTUP_PROMPT="Run startup recovery: use tmux list-sessions and tmux list-windows to check for surviving workers from a previous session. For each one, capture its output with tmux capture-pane and report status. Then say you are ready for instructions."

if [ "$CAPTAIN" = "claude" ]; then
    if [ "$FRESH" = true ]; then
        # Fresh start: use startup prompt, no --continue
        CMD="claude --dangerously-skip-permissions \"$STARTUP_PROMPT\""
    else
        # Resume: use --continue to resume last session
        CMD="claude --dangerously-skip-permissions --continue"
    fi
else
    # Codex
    if [ "$FRESH" = true ] || [ -z "$CODEX_SESSION_ID" ]; then
        # Fresh start or no session ID found
        CMD="codex --dangerously-bypass-approvals-and-sandbox \"$STARTUP_PROMPT\""
        if [ "$FRESH" = false ]; then
            echo "[restart-captain] No codex session ID found — starting fresh with prompt."
        fi
    else
        # Resume with session ID
        CMD="codex --dangerously-bypass-approvals-and-sandbox resume $CODEX_SESSION_ID"
    fi
fi

# ---------------------------------------------------------------------------
# Launch new captain
# ---------------------------------------------------------------------------
echo "[restart-captain] Launching: $CMD"

# Ensure we're in the captain working directory and have env vars
tmux send-keys -t captain:0 "cd /home/ubuntu/captain && set -a && . /home/ubuntu/env && set +a && $CMD" Enter

# ---------------------------------------------------------------------------
# Verify the new captain started
# ---------------------------------------------------------------------------
echo "[restart-captain] Waiting 5s for captain to start..."
sleep 5

# Re-check the shell PID (should be same) and look for a child process
SHELL_PID=$(tmux list-panes -t captain:0 -F '#{pane_pid}' 2>/dev/null || echo "")
if [ -n "$SHELL_PID" ]; then
    NEW_CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
    if [ -n "$NEW_CAPTAIN_PID" ]; then
        NEW_CAPTAIN_CMD=$(ps -o comm= -p "$NEW_CAPTAIN_PID" 2>/dev/null || echo "unknown")
        echo "[restart-captain] New captain running: PID $NEW_CAPTAIN_PID ($NEW_CAPTAIN_CMD)"
    else
        echo "[restart-captain] WARNING: No captain process detected yet — it may still be starting."
        # Check pane for signs of life
        PANE_CONTENT=$(tmux capture-pane -t captain:0 -p -S -10 2>/dev/null || true)
        echo "[restart-captain] Pane tail:"
        echo "$PANE_CONTENT" | tail -5
    fi
fi

echo "[restart-captain] Done."
