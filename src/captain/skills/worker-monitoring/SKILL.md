---
name: worker-monitoring
description: Status checks, reading worker output, checking if workers are running, intervention/patience, proactively unsticking workers, idle alerts, autosuggest caveat.
user-invocable: false
---

# Monitoring Workers

## Status Checks (Only When Asked)

Only check on workers for completion when the human asks. Do not proactively poll or monitor progress.

When the human asks for status:

- Capture the last 30 to 50 lines from the pane using `tmux capture-pane -t <target> -p -S -50`.
- Start small (20 to 30 lines) and only grab more if needed. Your context is precious; do not dump huge build logs into it.

When scanning worker status, check EVERY window in EVERY session:

- Workers can be running in any window number, not just window 0.
- Windows get renumbered when others are killed, and new tasks land in higher-numbered windows.
- Always enumerate with `tmux list-windows -t <session>`, then capture panes individually.
- Never assume a session has only one window, and never skip windows. If you only check window 0 or the active window, you will miss active workers and give the human a wrong status report.

## Intervention and Patience

- Kill stuck workers with ctrl-c or `kill` when the human requests it.
- Spin up as many workers as the task requires. There is no limit.
- Let workers cook. Workers sometimes appear stalled (rate-limited, thinking, waiting on sub-agents) but are actually fine. Do not panic if a worker looks idle for a while. Only intervene if the human asks you to or if a worker has clearly crashed (shell prompt returned). Avoid repeatedly killing and respawning workers for the same task; give them time to finish.

## Proactively Unstick Workers When You Notice a Problem

When you check on workers, whether the human asked or during a heartbeat check, do not passively report that a worker is stuck. If you can see the problem and know the answer, fix it by sending the worker a follow-up prompt.

You have a massive context advantage over individual workers. You know what the human wants, you have seen what other workers are doing, you know the project structure, and you have heard context the worker never got. Use that advantage.

When to intervene:

- The worker is asking a question you know the answer to ("which approach should I take?", "where is this config?", "should I use X or Y?"): tell them the answer.
- The worker is trying the wrong approach repeatedly: redirect them. "Stop trying X, the issue is Y. Do Z instead."
- The worker hit an error you recognize: tell them the fix.
- The worker is going in circles, undoing and redoing the same change: intervene with clear direction.
- The worker is blocked on something another worker already solved: pass along the solution.

When NOT to intervene:

- The worker is making steady progress: leave them alone.
- The worker is thinking or processing (spinner active): let them work.
- The worker is actively running (not at their input prompt): you cannot send input safely anyway.
- You do not actually know the answer: do not guess. Report to the human instead.

The rule is simple: if a worker is idle and stuck, and you know how to help, help. Do not relay the problem to the human and wait for instructions when you already have the answer. Send the worker a follow-up prompt with what they need, then tell the human what you did.

## Giving Workers Follow-on Tasks

You do NOT need to kill and restart a worker to give it a follow-on task

- Both Claude and Codex workers can take follow-up prompts when they are IDLE at their input prompt. Reuse the existing worker by sending a new prompt via `tmux send-keys`.
- Why this matters: reusing the same worker preserves its context from the previous task, which is valuable when the follow-up is related to what it just did.

## Claude Autosuggest Caveat

When you capture a worker's pane output, be aware that Claude Code and Codex might show an autosuggest prompt at the bottom of the pane. Text appearing after the last prompt marker (the `>` character) in the input area is NOT a command the worker is processing. It is autocomplete suggestion text that has not been submitted. Only text in the conversation area above the prompt (tool calls, results, assistant messages) represents actual work.

Signs a worker is genuinely stalled:

- The conversation area has not changed between checks.
- There is no active spinner or status indicator.

Signs a worker is fine:

- There is a spinner (like "Thinking", "Booping", etc.).
- New tool calls or results have appeared since your last check.

Do NOT kill workers just because you see unsubmitted text in their input prompt. That text is an autosuggest/autocomplete ghost. Judge worker state solely by the conversation area above the prompt line.

## Heartbeat Reviews

During a heartbeat nudge, check the status of all workers. If a worker is sitting on a prompt, nudge it to continue it work. If a worker is finished, verify that it has completed its work according to the proper procedure, then clean it up and tear it down if so.
Also check:

- Are there pending task definitions in `~/captain/tasks/pending/` with no corresponding active worker? Spin one up if so.
- Are there tmux windows with dead or idle shells (worker exited) that you have not reviewed?

If you find abandoned work, follow up immediately: capture what was done, assess what remains, and dispatch a continuation worker if needed. Then speak an update to the human, including the pertinent details.

If there is no substantive update in a heartbeat, do not speak a report using the speak command, just print out a quick message to that effect.
