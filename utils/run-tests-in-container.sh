#!/usr/bin/env bash
# Build the test Docker image and run the full test suite inside it.
# Usage:
#   ./utils/run-tests-in-container.sh          # run all tests (including integration)
#   ./utils/run-tests-in-container.sh --build  # force rebuild the image
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="voice-squad-test"

FORCE_BUILD=0
EXTRA_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --build) FORCE_BUILD=1 ;;
        *) EXTRA_ARGS+=("$arg") ;;
    esac
done

# Build image if it doesn't exist or --build was passed
if [ "$FORCE_BUILD" -eq 1 ] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "=== Building test image ==="
    docker build -f "$ROOT_DIR/Dockerfile.test" -t "$IMAGE_NAME" "$ROOT_DIR"
    echo ""
fi

echo "=== Running tests in container ==="
docker run --rm \
    -e TERM=xterm-256color \
    "$IMAGE_NAME" \
    "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
