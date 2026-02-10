#!/bin/bash
set -e

# Start dockerd in the background (docker-in-docker)
sudo sh -c 'dockerd &>/var/log/dockerd.log' &

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

# Launch the squad
/opt/squad/launch-squad.sh "$@" > /tmp/launch-squad.log 2>&1 &

# Launch the main menu
exec /opt/squad/main-menu.sh
