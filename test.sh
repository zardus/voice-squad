#!/usr/bin/env bash
# Run the test suite using docker compose with real service images.
# This does not interfere with any running voice-squad deployment.
#
# Usage:
#   ./test.sh                    # run all tests
#   ./test.sh api.spec.js        # run a specific test file
set -euo pipefail
cd "$(dirname "$0")"

# Source home/env if present — picks up API keys for captain E2E tests
# without requiring them to be separately exported on the host.
# home/env uses underscore-prefixed names (_OPENAI_API_KEY etc.) to avoid
# colliding with the host env, so map them to the real names here.
if [ -f home/env ]; then
    set -a; . home/env; set +a
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${_OPENAI_API_KEY:-}}"
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_ANTHROPIC_API_KEY:-}}"
fi

PROJECT=voice-squad-test
COMPOSE="docker compose -p $PROJECT -f docker-compose.test.yml"

cleanup() {
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

$COMPOSE run --build --rm test-runner "$@"
