---
name: worker-termination
description: Stubborn worker stop playbook, killing stuck workers, sending ctrl-c, the escalation steps.
user-invocable: false
---

# Terminating Stubborn Workers

## Stubborn Worker Stop Playbook (Claude/Codex)

When a worker must be stopped and a single Ctrl-C does not work, use this escalation order:

1. Confirm the pane target first with `tmux list-panes -a` so you do not interrupt the wrong worker.
2. If Claude is at the prompt with slash/autocomplete UI noise, clear it first with `Escape`, then `/exit`, then `Enter`.
3. If still running: send `Ctrl-C`, wait 2 to 3 seconds, check pane.
4. Repeat `Ctrl-C` up to 3 total times, each time waiting and re-checking.
5. If the process is still alive and the human asked to stop it now, kill the tmux window.

Do not spam keys blindly. Send one intervention step at a time and verify.
