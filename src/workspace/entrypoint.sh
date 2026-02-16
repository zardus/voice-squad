#!/bin/bash
set -e

# Ensure workspace tmux socket directory is accessible
sudo mkdir -p /run/workspace-tmux
sudo chown ubuntu:ubuntu /run/workspace-tmux
sudo chmod 755 /run/workspace-tmux

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

# Create workspace tmux session at a fixed socket path (workers run here)
tmux -S /run/workspace-tmux/default new-session -d -s workspace -c /home/ubuntu

# Create TMUX_TMPDIR compatibility symlink so captain's raw tmux commands
# (which resolve $TMUX_TMPDIR/tmux-{UID}/default) find this socket
mkdir -p /run/workspace-tmux/tmux-$(id -u)
ln -sf /run/workspace-tmux/default /run/workspace-tmux/tmux-$(id -u)/default

# Keep the container alive
exec sleep infinity
