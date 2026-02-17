#!/bin/bash
set -e

# Ensure runtime directory exists and is writable
sudo mkdir -p /run/fuse-auth-proxy
sudo chown ubuntu:ubuntu /run/fuse-auth-proxy

# Ensure home directory is writable
sudo chown ubuntu:ubuntu /home/ubuntu

# Create profiles directory
PROFILES_DIR="${FUSE_AUTH_PROFILES_DIR:-$HOME/captain/auth/profiles}"
mkdir -p "$PROFILES_DIR"

# Create default profile with empty credential files
DEFAULT_ACCOUNT="${FUSE_AUTH_DEFAULT_ACCOUNT:-default}"
mkdir -p "$PROFILES_DIR/$DEFAULT_ACCOUNT/claude"
mkdir -p "$PROFILES_DIR/$DEFAULT_ACCOUNT/codex"

for f in "$PROFILES_DIR/$DEFAULT_ACCOUNT/claude/.credentials.json" \
         "$PROFILES_DIR/$DEFAULT_ACCOUNT/codex/auth.json"; do
    [ -f "$f" ] || echo '{}' > "$f"
done

# Ensure mount points exist
mkdir -p "$HOME/.claude" "$HOME/.codex"

echo "[fuse-auth-proxy] Starting FUSE auth proxy daemon..."
echo "[fuse-auth-proxy] Profiles dir: $PROFILES_DIR"
echo "[fuse-auth-proxy] Default account: $DEFAULT_ACCOUNT"

# Run the FUSE daemon in foreground
exec python3 /opt/squad/fuse-auth-proxy/fuse_auth_proxy.py --foreground
