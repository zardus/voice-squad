---
name: tmux-reference
description: Full tmux command reference for managing workers — sessions, windows, send-keys, capture-pane, checking worker status.
user-invocable: false
---

# tmux Command Reference (Raw tmux Only)

You manage all workers via raw tmux commands through Bash.

Create a new tmux session for a project with its working directory:

```bash
tmux new-session -d -s <project> -c /home/ubuntu/<project>
```

Create a new window for a worker task:

```bash
tmux new-window -t <session> -n <task-name> -c /home/ubuntu/<project>
```

Launch a worker in that window (send the command via send-keys):

```bash
tmux send-keys -t <session>:<window> 'claude --dangerously-skip-permissions "$(cat ~/captain/tasks/pending/<task-name>.task)"' Enter
```

List all sessions:

```bash
tmux list-sessions
```

List windows in a session:

```bash
tmux list-windows -t <session>
```

List all panes across all sessions:

```bash
tmux list-panes -a
```

Kill a window:

```bash
tmux kill-window -t <session>:<window>
```

## Sending Input to Workers

Send text to a worker:

```bash
tmux send-keys -t <target> 'the text' Enter
```

Send control keys:

```bash
tmux send-keys -t <target> C-c
```

IMPORTANT: Always sleep 0.5 seconds between text input and control input (Enter, Escape, C-c). If you send text and Enter too fast in the same send-keys call, tmux may interpret it as a bracketed paste and the Enter will not register as a keypress. Either use two separate send-keys calls with a sleep between them, or use:

```bash
tmux send-keys -t <target> 'text'; sleep 0.5; tmux send-keys -t <target> Enter
```

Sometimes C-c is the same, needing to be sent twice after a short pause (0.5 seconds).

## Reading Worker Output

Capture pane output:

```bash
tmux capture-pane -t <target> -p -S -<lines>
```

IMPORTANT: use tail judiciously to avoid blowing out your context window. Do not dump 500 lines of worker output into your context. Use `tmux capture-pane -t <target> -p -S -50` to get the last 50 lines, or pipe through `tail -n 30`. Start small (20 to 30 lines) and only grab more if you need it.

## Checking If a Worker Is Still Running

Check the foreground process:

```bash
tmux list-panes -t <target> -F '#{pane_current_command}'
```

- If it shows "claude" or "node" or "codex", the agent is running.
- If it shows "bash" or "zsh", the agent has exited to shell.
