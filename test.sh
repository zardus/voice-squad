#!/usr/bin/env bash
# Run the test suite using docker compose with real service images.
# Each test file gets its own fully isolated stack (separate -p project),
# so all tests run in parallel.
#
# Usage:
#   ./test.sh                    # run all tests in parallel
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

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.test.yml"

# ── Build images once ────────────────────────────────────────
echo "=== Building images ==="
docker compose $COMPOSE_FILES build

# ── Discover test files ──────────────────────────────────────
if [ $# -gt 0 ]; then
    TEST_FILES=("$@")
else
    TEST_FILES=()
    for f in tests/*.spec.js; do
        TEST_FILES+=("$(basename "$f")")
    done
fi

echo ""
echo "=== Running ${#TEST_FILES[@]} test files in parallel ==="
echo ""

# ── Launch each test file in its own isolated stack ──────────
PIDS=()
PROJECTS=()
RESULTS_DIR=$(mktemp -d)

cleanup() {
    # Kill any still-running test subshells
    for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait "${PIDS[@]+"${PIDS[@]}"}" 2>/dev/null || true

    # Tear down all test stacks in parallel
    for proj in "${PROJECTS[@]+"${PROJECTS[@]}"}"; do
        docker compose -p "$proj" $COMPOSE_FILES down -v --remove-orphans 2>/dev/null &
    done
    wait
    rm -rf "$RESULTS_DIR"
}
trap cleanup EXIT

for spec in "${TEST_FILES[@]}"; do
    name="${spec%.spec.js}"
    project="squad-test-${name}"
    PROJECTS+=("$project")
    log="$RESULTS_DIR/${name}.log"

    (
        docker compose -p "$project" $COMPOSE_FILES run --build --rm test-runner \
            tests/"$spec" > "$log" 2>&1
        echo $? > "$RESULTS_DIR/${name}.exit"
    ) &
    PIDS+=($!)
    echo "  started: $spec (pid $!, project $project)"
done

# ── Wait for all and collect results ─────────────────────────
echo ""
FAILED=0
for i in "${!TEST_FILES[@]}"; do
    spec="${TEST_FILES[$i]}"
    name="${spec%.spec.js}"
    pid="${PIDS[$i]}"
    log="$RESULTS_DIR/${name}.log"

    wait "$pid" 2>/dev/null || true
    exit_code=$(cat "$RESULTS_DIR/${name}.exit" 2>/dev/null || echo 1)

    if [ "$exit_code" -eq 0 ]; then
        echo "  PASS: $spec"
    else
        echo "  FAIL: $spec (exit $exit_code)"
        FAILED=$((FAILED + 1))
        # Print the log for failed tests
        echo "  ---- $spec output ----"
        cat "$log" | sed 's/^/    /'
        echo "  ---- end $spec ----"
    fi
done

echo ""
if [ "$FAILED" -gt 0 ]; then
    echo "=== ${FAILED} test file(s) failed ==="
    exit 1
else
    echo "=== All ${#TEST_FILES[@]} test files passed ==="
fi
