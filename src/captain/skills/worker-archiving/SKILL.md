---
name: worker-archiving
description: Cleaning up finished workers, mandatory output archiving before kill, task completion accountability, verify before closing, complete means complete, never accept deferred, continue incomplete work, do not let tasks silently drop.
user-invocable: false
---

# Archiving and Completing Tasks

## Task Completion Accountability

You are accountable for task completion, not just task dispatch. Dispatching work is not the finish line — completion is. A task is not done until the work is verified complete.

### Never Accept "Deferred" From Workers

If a worker claims a deliverable is "too complex," "requires too much work," or "deferred to a follow-up," that is NOT acceptable. The worker's job is to do the work, not to decide what's too hard. When you see a worker defer something:

1. Do NOT report the task as complete.
2. Immediately send the worker back to finish.
3. "It's complex" is never a blocker. "The compiler literally cannot do this" is a blocker.

### Complete Means Complete

A task is complete ONLY when every deliverable in the original task definition is verified done. Not "mostly done." Not "done except for one thing." If the task said "fix 13 gaps," then 12/13 is NOT complete. Do not use the word "complete" with caveats. If there are caveats, it is not complete.

### Verify Against the Original Task Definition

Before reporting a task done, re-read the original task file. Check every numbered deliverable, every requirement, every verification step. If any single item is missing, the task is not done. Do not let worker summaries substitute for your own verification — workers will downplay what they skipped.

### Verify Before Closing

When a worker finishes or exits, do not blindly mark the task as done. Check the actual outcome:

- Did the worker complete all phases of the plan, or just the first one?
- Are tests passing? Did the worker even run the tests?
- Is the feature fully implemented, or did the worker stop after scaffolding?
- Did the worker commit and push, or did it exit before finishing git operations?
- Did the worker hit an error and bail out early?

Capture the worker's pane output and read it critically. A worker that exited is not the same as a worker that succeeded.

### Continue Incomplete Work Immediately

If a worker finished but the task is not fully complete, force the worker to continue immediately. Do not wait for the human to notice the gap. Do not report the task as done when it is not.

Common situations:

- Worker completed step 1 of 3: tell the worker to continue with steps 2 and 3.
- Worker's tests are failing: make them fix it.
- Worker committed but did not push: tell the worker to push, or handle it in the next worker's instructions.

### Do Not Let Workers Be Lazy

Workers can sometimes be lazy. They might claim that failing testcases are expected (failing testcases are not acceptible under any circumstances), or that something is too complex to do, or any number of excuses. Do not accept these excuses. Force the workers to not only finish their tasks but finish them properly (e.g., with passing testcases).

### Do Not Let Tasks Silently Drop

A worker dying or exiting early is normal. Workers hit errors, get rate-limited, or just stop. That is fine. What is not fine is the captain losing track of the work. If a worker stopped, you must either:

1. Confirm the task is genuinely complete and proceed to cleanup, or
2. Spin up a new worker to finish it. Give it clear context: what was already done, what remains, and where to pick up. Do not make it start from scratch.

There is no third option. Tasks do not disappear because a worker did.

## Cleaning Up Finished Workers

When you check on workers (either because the human asked or because you noticed), and a worker has clearly finished its task:

1. Capture and summarize what the worker accomplished (commits made, files changed, key outcomes) to `~/captain/tasks/archived/<task-name>.summary`.
2. Capture the entire available tmux pane output of the worker to `~/captain/tasks/archived/<task-name>.log`.
3. Save the task definition of the worker to `~/captain/tasks/archived/<task-name>.task`.
4. Kill the worker's tmux window to free resources.
5. Do NOT wait for the human to ask you to clean up. Proactively shut down finished workers after summarizing their work.

This keeps the tmux session clean and avoids accumulating idle workers. The human should be able to ask "what did that worker do?" and get a summary even after the worker is gone.

## Mandatory Worker Output Archiving (Before Kill)

Before killing any worker tmux window (cleanup, pruning finished workers, etc.), you MUST save the full pane output to `~/captain/tasks/archived`.

- Ensure the archive directory exists: `mkdir -p ~/captain/tasks/archived`
- Capture a generous amount of scrollback: `tmux capture-pane -t <target> -p -S -10000 > ~/captain/tasks/archived/<task-name>.log`

```bash
mkdir -p ~/captain/archived
tmux capture-pane -t <session>:<window> -p -S -10000 > ~/captain/tasks/archived/<task-name>.log
tmux kill-window -t <session>:<window>
```

Afterwards, summarize the results to ~/captain/tasks/archived/<task-name>.results along with a short description/title to ~/captain/tasks/archived/<task-name>.title

## Completion Verification Checklist (Before Reporting Done)

Before telling the human a task is complete, verify from pane output:

1. Deliverables are actually implemented (not just planned).
2. Required verification commands ran and passed.
3. Commit exists with expected message/scope.
4. Push happened (no "ahead of origin by N commits" left behind).
5. Final worker message summarizes what changed and what was validated.

If push is missing, dispatch immediate follow-up: "push the existing commit and report remote branch + hash."
