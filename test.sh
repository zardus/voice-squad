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

# Source home/env if present — picks up API keys for overseer E2E tests
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

# Export the workspace image name so per-test stacks (which use different -p
# project names) can still find it. The workspace service has replicas:0 so
# it's only built here under the default project name.
export SQUAD_WORKSPACE_IMAGE="$(basename "$(pwd)")-workspace"

# ── Discover test files ──────────────────────────────────────
if [ $# -gt 0 ]; then
    TEST_FILES=("$@")
else
    TEST_FILES=()
    for f in tests/*.spec.js; do
        TEST_FILES+=("$(basename "$f")")
    done
fi

# Max parallel test stacks. Each stack creates a Docker network; too many in
# parallel exhausts Docker's default address pools ("all predefined address
# pools have been fully subnetted"). 8 is safe for typical CI runners.
MAX_PARALLEL="${MAX_PARALLEL:-8}"

echo ""
echo "=== Running ${#TEST_FILES[@]} test files (max $MAX_PARALLEL parallel) ==="
echo ""

# ── Launch test files in batches ─────────────────────────────
ALL_PROJECTS=()
RESULTS_DIR=$(mktemp -d)
# Unique run ID to prevent project name collisions between simultaneous test.sh runs
RUN_ID="$$"

cleanup() {
    # Kill any still-running test subshells
    for pid in "${BATCH_PIDS[@]+"${BATCH_PIDS[@]}"}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait "${BATCH_PIDS[@]+"${BATCH_PIDS[@]}"}" 2>/dev/null || true

    # Tear down all test stacks in parallel
    for proj in "${ALL_PROJECTS[@]+"${ALL_PROJECTS[@]}"}"; do
        docker compose -p "$proj" $COMPOSE_FILES down -v --remove-orphans 2>/dev/null &
    done
    wait
    rm -rf "$RESULTS_DIR"
}
trap cleanup EXIT

BATCH_PIDS=()
BATCH_PROJECTS=()

flush_batch() {
    # Wait for current batch to finish
    for pid in "${BATCH_PIDS[@]+"${BATCH_PIDS[@]}"}"; do
        wait "$pid" 2>/dev/null || true
    done

    # Tear down batch stacks to free Docker networks
    for proj in "${BATCH_PROJECTS[@]+"${BATCH_PROJECTS[@]}"}"; do
        docker compose -p "$proj" $COMPOSE_FILES down -v --remove-orphans 2>/dev/null &
    done
    wait

    BATCH_PIDS=()
    BATCH_PROJECTS=()
}

for spec in "${TEST_FILES[@]}"; do
    name="${spec%.spec.js}"
    project="squad-test-${RUN_ID}-${name}"
    ALL_PROJECTS+=("$project")
    BATCH_PROJECTS+=("$project")
    log="$RESULTS_DIR/${name}.log"

    (
        docker compose -p "$project" $COMPOSE_FILES run --build --rm test-runner \
            tests/"$spec" > "$log" 2>&1
        echo $? > "$RESULTS_DIR/${name}.exit"
    ) &
    BATCH_PIDS+=($!)
    echo "  started: $spec (pid $!, project $project)"

    # When batch is full, wait for it to finish and clean up networks
    if [ "${#BATCH_PIDS[@]}" -ge "$MAX_PARALLEL" ]; then
        echo "  --- waiting for batch of ${#BATCH_PIDS[@]} to finish ---"
        flush_batch
    fi
done

# Wait for final (partial) batch
if [ "${#BATCH_PIDS[@]}" -gt 0 ]; then
    echo "  --- waiting for final batch of ${#BATCH_PIDS[@]} ---"
    flush_batch
fi

# ── Collect results ──────────────────────────────────────────
echo ""
FAILED=0
for spec in "${TEST_FILES[@]}"; do
    name="${spec%.spec.js}"
    log="$RESULTS_DIR/${name}.log"

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
