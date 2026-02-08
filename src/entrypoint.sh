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

# Source user environment if present
[ -f /home/ubuntu/env ] && . /home/ubuntu/env

# Launch the squad
exec /opt/squad/launch-squad.sh "$@"
