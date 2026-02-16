#!/bin/bash
# switch-account.sh — Switch the active account for claude or codex
#
# Usage: switch-account.sh <claude|codex> <email>
#
# Accounts are stored in ~/captain/accounts/ as:
#   claude-<email>   (symlinked from ~/.claude.json)
#   codex-<email>    (symlinked from ~/.codex/auth.json)
#
# If the account file doesn't exist yet, creates a blank one and runs login.
# After login, restarts the captain with instructions to sequentially restart
# all workers of that tool type.
#
# Environment:
#   CAPTAIN_TMUX_SOCKET  Path to the captain's tmux socket.

set -euo pipefail

TOOL="${1:-}"
EMAIL="${2:-}"

if [ -z "$TOOL" ] || [ -z "$EMAIL" ]; then
    echo "Usage: switch-account.sh <claude|codex> <email>"
    echo ""
    echo "Examples:"
    echo "  switch-account.sh claude me@example.com"
    echo "  switch-account.sh codex alt@example.com"
    echo ""
    echo "Current symlinks:"
    ls -l ~/.claude.json 2>/dev/null || echo "  ~/.claude.json — not a symlink"
    ls -l ~/.codex/auth.json 2>/dev/null || echo "  ~/.codex/auth.json — not a symlink"
    exit 1
fi

if [ "$TOOL" != "claude" ] && [ "$TOOL" != "codex" ]; then
    echo "Error: tool must be 'claude' or 'codex' (got '$TOOL')"
    exit 1
fi

# Build tmux opts for captain socket
TMUX_OPTS=()
if [ -n "${CAPTAIN_TMUX_SOCKET:-}" ]; then
    TMUX_OPTS=("-S" "$CAPTAIN_TMUX_SOCKET")
fi

ACCOUNTS_DIR="$HOME/captain/accounts"
mkdir -p "$ACCOUNTS_DIR"

ACCOUNT_FILE="$ACCOUNTS_DIR/${TOOL}-${EMAIL}"

# Create blank account file if it doesn't exist
if [ ! -f "$ACCOUNT_FILE" ]; then
    echo "Creating new account file: $ACCOUNT_FILE"
    echo '{}' > "$ACCOUNT_FILE"
fi

# Update the symlink
if [ "$TOOL" = "claude" ]; then
    rm -f "$HOME/.claude.json"
    ln -s "$ACCOUNT_FILE" "$HOME/.claude.json"
    echo "Linked ~/.claude.json -> $ACCOUNT_FILE"
else
    mkdir -p "$HOME/.codex"
    rm -f "$HOME/.codex/auth.json"
    ln -s "$ACCOUNT_FILE" "$HOME/.codex/auth.json"
    echo "Linked ~/.codex/auth.json -> $ACCOUNT_FILE"
fi

# Run interactive login
echo ""
if [ "$TOOL" = "claude" ]; then
    echo "==> Launching Claude login..."
    claude login || true
else
    echo "==> Launching Codex login..."
    codex auth login || true
fi

echo ""
echo "==> Login complete. Restarting captain..."

# ---------------------------------------------------------------------------
# Restart the captain
# ---------------------------------------------------------------------------

if ! tmux "${TMUX_OPTS[@]}" has-session -t captain 2>/dev/null; then
    echo "ERROR: tmux session 'captain' not found! Cannot restart captain."
    exit 1
fi

CAPTAIN="${SQUAD_CAPTAIN:-claude}"

# Find and kill the old captain process
SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t captain:0 -F '#{pane_pid}')
CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')

if [ -n "$CAPTAIN_PID" ]; then
    echo "    Killing captain process (PID $CAPTAIN_PID)..."
    kill -- -"$CAPTAIN_PID" 2>/dev/null || kill "$CAPTAIN_PID" 2>/dev/null || true

    for _ in $(seq 1 10); do
        kill -0 "$CAPTAIN_PID" 2>/dev/null || break
        sleep 0.5
    done

    if kill -0 "$CAPTAIN_PID" 2>/dev/null; then
        echo "    Force-killing..."
        kill -9 -- -"$CAPTAIN_PID" 2>/dev/null || kill -9 "$CAPTAIN_PID" 2>/dev/null || true
        sleep 1
    fi
else
    echo "    No captain process found — starting fresh."
fi

sleep 1
tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 C-c
sleep 0.5

# Build the restart instruction for the new captain
RESTART_MSG="The $TOOL account was just switched to $EMAIL. Restart all $TOOL workers across all tmux sessions. Follow the Restarting Workers procedure in your instructions — kill and restart each worker sequentially, one at a time. Speak updates as you go."

# Launch new captain with the restart instruction as its initial prompt
echo "    Launching new captain ($CAPTAIN) with worker restart instructions..."
if [ "$CAPTAIN" = "claude" ]; then
    tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 "unset TMUX && claude --dangerously-skip-permissions '$RESTART_MSG'" Enter
else
    tmux "${TMUX_OPTS[@]}" send-keys -t captain:0 "unset TMUX && codex --dangerously-bypass-approvals-and-sandbox '$RESTART_MSG'" Enter
fi

# Verify the new captain started
sleep 3
NEW_CAPTAIN_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
if [ -n "$NEW_CAPTAIN_PID" ]; then
    echo "    New captain running (PID $NEW_CAPTAIN_PID)."
else
    echo "    WARNING: Captain may still be starting up."
fi

echo ""
echo "=== Account switch complete ==="
echo "  Tool:    $TOOL"
echo "  Account: $EMAIL"
echo "  File:    $ACCOUNT_FILE"
echo "  Captain: restarted with worker restart instructions"
