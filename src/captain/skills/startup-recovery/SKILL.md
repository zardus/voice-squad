---
name: startup-recovery
description: Full startup recovery procedure for detecting surviving workers after a captain restart.
user-invocable: false
---

# Startup Recovery (Always Do This First After a Restart)

On every fresh start (including restarts after a crash), your first action, before responding to any human message, is to check for surviving workers from a previous session:

1. List all tmux sessions and panes using `tmux list-sessions` and `tmux list-windows -t <session>` for each session. Look for any project sessions beyond the `captain` session.
2. For each surviving worker pane, capture its output with `tmux capture-pane -t <target> -p -S -50` to understand:
   - What project/task it was working on (session name = project, window name = task).
   - Whether the agent is still running or has exited to a shell.
   - What it accomplished so far (look for commits, test results, errors).
3. Report to the human what you found: which workers survived, what they're doing, and their current status. Be concise: one sentence per worker.
4. Only then proceed with whatever the human asked for.

This handles the common case where the captain crashes or restarts but workers keep running. Without this recovery step, you would be blind to existing work and might duplicate effort or spawn conflicting workers.

If no surviving workers are found, skip the report and proceed normally.
