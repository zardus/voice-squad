#!/bin/bash
# switch-account.sh — Switch the active account for claude or codex
#
# Usage: switch-account.sh <claude|codex> <email>
#
# Accounts are stored in ~/overseer/accounts/ as:
#   claude-<email>   (symlinked from ~/.claude.json)
#   codex-<email>    (symlinked from ~/.codex/auth.json)
#
# If the account file doesn't exist yet, creates a blank one and runs login.
# After login, restarts the overseer with instructions to sequentially restart
# all workers of that tool type.
#
# Environment:
#   OVERSEER_TMUX_SOCKET  Path to the overseer's tmux socket.

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

# Build tmux opts for overseer socket
TMUX_OPTS=()
if [ -n "${OVERSEER_TMUX_SOCKET:-}" ]; then
    TMUX_OPTS=("-S" "$OVERSEER_TMUX_SOCKET")
fi

ACCOUNTS_DIR="$HOME/overseer/accounts"
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
echo "==> Login complete. Restarting overseer..."

# ---------------------------------------------------------------------------
# Restart the overseer
# ---------------------------------------------------------------------------

if ! tmux "${TMUX_OPTS[@]}" has-session -t overseer 2>/dev/null; then
    echo "ERROR: tmux session 'overseer' not found! Cannot restart overseer."
    exit 1
fi

OVERSEER="${SQUAD_OVERSEER:-codex}"

# Find and kill the old overseer process
SHELL_PID=$(tmux "${TMUX_OPTS[@]}" list-panes -t overseer:0 -F '#{pane_pid}')
OVERSEER_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')

if [ -n "$OVERSEER_PID" ]; then
    echo "    Killing overseer process (PID $OVERSEER_PID)..."
    kill -- -"$OVERSEER_PID" 2>/dev/null || kill "$OVERSEER_PID" 2>/dev/null || true

    for _ in $(seq 1 10); do
        kill -0 "$OVERSEER_PID" 2>/dev/null || break
        sleep 0.5
    done

    if kill -0 "$OVERSEER_PID" 2>/dev/null; then
        echo "    Force-killing..."
        kill -9 -- -"$OVERSEER_PID" 2>/dev/null || kill -9 "$OVERSEER_PID" 2>/dev/null || true
        sleep 1
    fi
else
    echo "    No overseer process found — starting fresh."
fi

sleep 1
tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 C-c
sleep 0.5

# Build the restart instruction for the new overseer
RESTART_MSG="The $TOOL account was just switched to $EMAIL. Check on all active workers and report their status."

# Launch new overseer with the restart instruction as its initial prompt
echo "    Launching new overseer ($OVERSEER) with status check instructions..."
if [ "$OVERSEER" = "claude" ]; then
    tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 "unset TMUX && claude --dangerously-skip-permissions '$RESTART_MSG'" Enter
else
    tmux "${TMUX_OPTS[@]}" send-keys -t overseer:0 "unset TMUX && codex --dangerously-bypass-approvals-and-sandbox '$RESTART_MSG'" Enter
fi

# Verify the new overseer started
sleep 3
NEW_OVERSEER_PID=$(ps -o pid= --ppid "$SHELL_PID" 2>/dev/null | head -1 | tr -d ' ')
if [ -n "$NEW_OVERSEER_PID" ]; then
    echo "    New overseer running (PID $NEW_OVERSEER_PID)."
else
    echo "    WARNING: Overseer may still be starting up."
fi

echo ""
echo "=== Account switch complete ==="
echo "  Tool:    $TOOL"
echo "  Account: $EMAIL"
echo "  File:    $ACCOUNT_FILE"
echo "  Overseer: restarted with status check instructions"
