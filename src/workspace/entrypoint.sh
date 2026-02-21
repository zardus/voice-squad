#!/bin/bash
set -e

WORKSPACE_TMUX_SOCKET="${WORKSPACE_TMUX_SOCKET:-/run/squad-sockets/workspace-tmux/default}"
WORKSPACE_TMUX_DIR="$(dirname "$WORKSPACE_TMUX_SOCKET")"
TMUX_TMPDIR="${TMUX_TMPDIR:-$WORKSPACE_TMUX_DIR}"
export TMUX_TMPDIR

# Ensure workspace tmux socket directory is accessible
sudo mkdir -p "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"
sudo chown ubuntu:ubuntu "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"
sudo chmod 755 "$WORKSPACE_TMUX_DIR" "$TMUX_TMPDIR"

# Start dockerd in the background (docker-in-docker)
# Use vfs storage driver to avoid overlay-on-overlay issues when the
# container filesystem is itself overlayfs. Slower but always works.
sudo sh -c 'dockerd --storage-driver=vfs &>/var/log/dockerd.log' &

# Wait for docker to be ready
echo "Waiting for dockerd..."
timeout=30
while ! sudo docker info &>/dev/null && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done
if [ $timeout -eq 0 ]; then
    echo "Warning: dockerd failed to start within 30s, continuing anyway"
else
    echo "dockerd ready"
fi

# Ensure home directory is writable (volume mounts may be owned by root)
sudo chown ubuntu:ubuntu /home/ubuntu
sudo chown -R ubuntu:ubuntu /home/ubuntu/.codex /home/ubuntu/.claude 2>/dev/null || true

# Source user environment if present (set -a auto-exports all vars)
if [ -f /home/ubuntu/env ]; then
    set -a
    . /home/ubuntu/env
    set +a
fi

# Use underscored key names from ~/env when primary vars are unset.
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"

# Create workspace tmux session at a fixed socket path (workers run here)
tmux -S "$WORKSPACE_TMUX_SOCKET" new-session -d -s workspace -c /home/ubuntu

# Create TMUX_TMPDIR compatibility symlink so captain's raw tmux commands
# (which resolve $TMUX_TMPDIR/tmux-{UID}/default) find this socket
mkdir -p "$TMUX_TMPDIR/tmux-$(id -u)"
ln -sf "$WORKSPACE_TMUX_SOCKET" "$TMUX_TMPDIR/tmux-$(id -u)/default"

# Keep the container alive
exec sleep infinity
