#!/usr/bin/env bash
# Build the test Docker image and run only the screenshot spec,
# then copy the generated PNGs to screenshots/ in the repo root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="voice-squad-test"
CONTAINER="voice-squad-screenshots"

echo "=== Building test image ==="
docker build -f "$SCRIPT_DIR/Dockerfile.test" -t "$IMAGE" "$SCRIPT_DIR"

echo ""
echo "=== Running screenshot spec ==="
# Remove any previous container with the same name
docker rm -f "$CONTAINER" 2>/dev/null || true

docker run --name "$CONTAINER" "$IMAGE" tests/screenshots.spec.js || true

echo ""
echo "=== Copying screenshots ==="
mkdir -p "$SCRIPT_DIR/screenshots"
docker cp "$CONTAINER:/tmp/screenshots/terminal-tab.png" "$SCRIPT_DIR/screenshots/terminal-tab.png"
docker cp "$CONTAINER:/tmp/screenshots/status-tab.png" "$SCRIPT_DIR/screenshots/status-tab.png"
docker cp "$CONTAINER:/tmp/screenshots/voice-tab.png" "$SCRIPT_DIR/screenshots/voice-tab.png"

# Clean up
docker rm -f "$CONTAINER" >/dev/null 2>&1

echo ""
echo "=== Done! Screenshots saved to screenshots/ ==="
ls -la "$SCRIPT_DIR/screenshots/"
