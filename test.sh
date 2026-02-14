#!/usr/bin/env bash
# Run the test suite using docker compose with real service images.
# This does not interfere with any running voice-squad deployment.
#
# Usage:
#   ./test.sh                    # run all tests
#   ./test.sh api.spec.js        # run a specific test file
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=voice-squad-test
COMPOSE="docker compose -p $PROJECT -f docker-compose.test.yml"

cleanup() {
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

$COMPOSE run --build --rm test-runner "$@"
