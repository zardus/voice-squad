---
name: worker-starting
description: Spawn flow, project directories, task definition files, choosing Claude vs Codex, worker prompt checklist.
user-invocable: false
---

# Starting Workers

## Project Directories

All projects live directly under `/home/ubuntu/`. Before spawning workers, set up the project directory:

- Clone a git repo: `git clone <url> /home/ubuntu/<project>`
- Create a new directory: `mkdir -p /home/ubuntu/<project>`
- Use an existing directory that's already set up

Then create a new tmux session for that project. Use a descriptive session name (e.g., the repo/project name). All workers for that project run inside this session.

## Task Definition Files

Before launching a worker, write the task prompt to a file:

- Directory: `~/captain/tasks/pending/`
- Filename: `<task-name>.task` (use the same name as the tmux window)
- Content: the full prompt that will be sent to the worker

Example:

```bash
mkdir -p ~/captain/tasks/pending
cat > ~/captain/tasks/pending/fix-auth.task << 'EOF'
Fix the authentication bug in the login flow...
EOF
```

Then launch the worker using that file:

```bash
codex --dangerously-bypass-approvals-and-sandbox "$(cat ~/captain/tasks/pending/fix-auth.task)"
```

When a worker is finished and you clean it up, also move its task definition from pending to archived:

```bash
mkdir -p ~/captain/tasks/archived
mv ~/captain/tasks/pending/<task-name>.task ~/captain/tasks/archived/<task-name>.task
```

This keeps `~/captain/tasks/pending/` clean so it only contains active/upcoming tasks.
`~/captain/tasks/archived/` serves as a history of what was dispatched.

## Spawn Flow (Do This Every Time)

1. Set up the project directory under `/home/ubuntu/`.
2. Create a task definition file under `/home/ubuntu/captain/tasks/pending` with the command for the worker.
2. Create a new tmux session for the project, starting in the project directory:
   ```bash
   tmux new-session -d -s <project-name> -c /home/ubuntu/<project>
   ```
3. Create windows in that session and launch workers:
   - Claude workers: `claude --dangerously-skip-permissions < ~/captain/tasks/pending/<task-name>.task`
   - Codex workers: `codex --dangerously-bypass-approvals-and-sandbox "$(cat ~/captain/tasks/pending/<task-name>.task)`
   NOTE: workers should be started *interactively* so that you can continue to interact with them. Do not start in full-auto/exec/print mode.
4. Verify startup. Wait about 5 seconds, then capture pane output to confirm the worker launched and is running. Look for immediate failure:
   - bash syntax errors
   - "command not found"
   - crashes
   - permission errors
   - the shell prompt reappearing (meaning the process exited)
   If the worker failed, diagnose and retry before reporting to the human.
5. After confirming the worker is running, report to the human what you dispatched. Do not wait for the worker to finish.

For simple tasks, one worker in the session is fine. For complex tasks, spin up multiple workers in separate windows within the same project session. However, be careful about workers that will clobber each other. For example, two different refactors in the same source repository will likely cause problems.

## Choosing a Worker Tool (Claude vs Codex)

Two CLI tools are available for workers: `claude` and `codex`.

- If the human specifies which tool to use, use that. No second-guessing.
- If the human does not specify, alternate to balance load across providers. Keep a mental tally of which tool you have been dispatching in this session and pick the least-used one. This spreads usage across providers and avoids burning through rate limits on one side.

Quota awareness:

- If you start hitting rate limits, quota errors, or slow responses from one provider, switch to the other.
- Do not burn time waiting. Pivot.

## Worker Task Prompt Checklist (Always Include)

Every worker launch prompt should explicitly include:

- Absolute repo path (`/home/ubuntu/<repo>`).
- Branch name to use/create.
- Required env step when relevant: `set -a; . /home/ubuntu/env; set +a`.
- Concrete deliverable list (files/features/fixes).
- Verification commands (tests/build/lint).
- Git end-state requirement: commit AND push, then report commit hash.
- "If blocked, report exact blocker and best next step."

If these are missing, the worker will often stop early or return ambiguous output.
