# Auditing Worker Output

## Auditor Verification (Opt-In)

By default, the captain verifies task completion itself using the "Verify Before Closing" checklist (see `worker-archiving.md`): capture pane output, check deliverables, confirm tests passed, confirm git push. A separate auditor worker is only spun up when the user or the task definition explicitly requests auditing (e.g., "audit this", "use an auditor", "verify with an independent worker").

When auditing IS requested, the captain spins up a separate **auditor worker** to independently verify the work before marking the task as done or archiving it.

### Auditor Setup

- The auditor is a fresh worker in a new tmux window, working in the same repository as the original worker.
- The auditor receives the original task definition (from the `.task` file) so it knows exactly what was required.
- Name the auditor window `audit-<task-name>` so it is clearly distinguishable from the original worker.

### What the Auditor Checks

- Code compiles and builds successfully.
- All tests pass (run the actual test commands, do not just read code).
- Required features actually work — not stubbed, not partially implemented, not mocked.
- Git commits exist covering the task's deliverables, and were pushed to the remote.
- Git push happened (no unpushed commits left behind).
- No shortcuts, stubs, TODOs-as-implementation, or deferred work.
- Every numbered deliverable in the original task definition is satisfied.

### Auditor Rules

- Auditors must NEVER modify code — they only read, build, and test. Auditors should verify the working tree is clean (no uncommitted changes) before and after running verification commands to ensure the worker's commits are the true source of truth.
- Auditors must be brutal and honest — no "it's mostly done" or "close enough."
- Auditors must run the verification commands specified in the task definition or the repo's standard build/test pipeline, not just read the code.
- A task with ANY failing test is a FAIL, period.
- A task with ANY missing deliverable is a FAIL, period.

### Auditor Verdict

The auditor reports one of two outcomes:

- **PASS**: every deliverable verified, all builds and tests green, git state correct. The captain archives the task and reports completion to the human.
- **FAIL**: with a specific list of what is missing or broken. The captain does NOT report the task as done. Instead, the captain spins up a new worker (or sends the original worker back) with explicit instructions about what the auditor found. The cycle repeats — work, audit, work, audit — until the auditor passes.

### Task-Type-Specific Audits

Not every task is a code implementation task. The captain must tailor the auditor's instructions to match what the task actually was. The auditor prompt should tell the auditor what kind of verification to perform. Examples:

- **Implementation tasks**: build, run tests, verify features work, check linkage or whatever the task required.
- **Bug fix tasks**: reproduce the original bug scenario and confirm it's fixed, plus run the full test suite.
- **Documentation/config tasks**: verify the content is correct, complete, and in the right location. No build needed.
- **PR/review tasks**: check the PR was created, has the right content, and targets the right branch.
- **Infrastructure/DevOps tasks**: verify the deployment, service, or config change is live and working.
- **Research/analysis tasks**: review findings for completeness and accuracy against the original question.
