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

# Start FUSE auth proxy if enabled (default: off — set FUSE_AUTH_ENABLED=1 to enable)
if [ "${FUSE_AUTH_ENABLED:-}" = "1" ]; then
    echo "[workspace] Starting FUSE auth proxy..."
    sudo mkdir -p /run/fuse-auth-proxy
    sudo chown ubuntu:ubuntu /run/fuse-auth-proxy

    PROFILES_DIR="${FUSE_AUTH_PROFILES_DIR:-$HOME/captain/auth/profiles}"
    mkdir -p "$PROFILES_DIR"

    # Create default profile
    DEFAULT_ACCOUNT="${FUSE_AUTH_DEFAULT_ACCOUNT:-default}"
    mkdir -p "$PROFILES_DIR/$DEFAULT_ACCOUNT/claude" "$PROFILES_DIR/$DEFAULT_ACCOUNT/codex"
    [ -f "$PROFILES_DIR/$DEFAULT_ACCOUNT/claude/.credentials.json" ] || echo '{}' > "$PROFILES_DIR/$DEFAULT_ACCOUNT/claude/.credentials.json"
    [ -f "$PROFILES_DIR/$DEFAULT_ACCOUNT/codex/auth.json" ] || echo '{}' > "$PROFILES_DIR/$DEFAULT_ACCOUNT/codex/auth.json"

    # Ensure credential directories exist before mounting
    mkdir -p "$HOME/.claude" "$HOME/.codex"

    python3 /opt/squad/fuse-auth-proxy/fuse_auth_proxy.py --foreground &
    FUSE_PID=$!
    echo "[workspace] FUSE auth proxy started (PID $FUSE_PID)"

    # Wait for ready marker
    fuse_timeout=10
    while [ ! -f /run/fuse-auth-proxy/ready ] && [ $fuse_timeout -gt 0 ]; do
        sleep 0.5
        fuse_timeout=$((fuse_timeout - 1))
    done
    if [ -f /run/fuse-auth-proxy/ready ]; then
        echo "[workspace] FUSE auth proxy ready"
    else
        echo "[workspace] WARNING: FUSE auth proxy may not be ready"
    fi
fi

# Create workspace tmux session at a fixed socket path (workers run here)
tmux -S /run/workspace-tmux/default new-session -d -s workspace -c /home/ubuntu

# Create TMUX_TMPDIR compatibility symlink so captain's raw tmux commands
# (which resolve $TMUX_TMPDIR/tmux-{UID}/default) find this socket
mkdir -p /run/workspace-tmux/tmux-$(id -u)
ln -sf /run/workspace-tmux/default /run/workspace-tmux/tmux-$(id -u)/default

# Keep the container alive
exec sleep infinity
