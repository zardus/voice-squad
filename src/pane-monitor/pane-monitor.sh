#!/bin/bash
# pane-monitor.sh — Monitor all tmux panes (captain heartbeat + worker idle detection).
#
# Captain pane (captain:0): configurable idle threshold → injects HEARTBEAT nudge
# Worker panes (on workspace tmux server): 30-second idle threshold → sends IDLE ALERT to captain
#
# Checks every 1 second, tracks per-pane state via content hashing.
# One-shot notification per idle period; resets when activity resumes.
# Dynamically discovers new/killed sessions/windows.
#
# Environment:
#   CAPTAIN_TMUX_SOCKET       — socket path for captain tmux server (for sending alerts + monitoring captain)
#   WORKSPACE_TMUX_SOCKET     — socket path for workspace tmux server (for monitoring workers)
#   HEARTBEAT_INTERVAL_SECONDS — captain heartbeat threshold in seconds (default: 900 = 15 minutes)

WORKER_THRESHOLD=30     # 30 seconds
HEARTBEAT_THRESHOLD="${HEARTBEAT_INTERVAL_SECONDS:-900}"
LOGFILE="/tmp/pane-monitor.log"

set -o pipefail

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Pane monitor started (pid=$$, worker_threshold=${WORKER_THRESHOLD}s, heartbeat_threshold=${HEARTBEAT_THRESHOLD}s)"

declare -A last_hash=( )
declare -A last_change_epoch=( )
declare -A notified_idle=( )

threshold_for_pane() {
    if [ "$1" == "captain:0" ]; then
        echo "$HEARTBEAT_THRESHOLD"
    else
        echo "$WORKER_THRESHOLD"
    fi
}

while true
do
    while read -r -a LINE
    do
        socket=${LINE[0]}
        pane=${LINE[1]}
        key="${socket}|${pane}"
        now_epoch=$(date +%s)
        threshold=$(threshold_for_pane "$pane")

        pane_hash=$(tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null | md5sum) || continue
        if [ "${last_hash[$key]:-}" != "$pane_hash" ]
        then
            last_hash[$key]="$pane_hash"
            last_change_epoch[$key]="$now_epoch"
            notified_idle[$key]=0
            continue
        fi

        unchanged_for=$(( now_epoch - ${last_change_epoch[$key]:-$now_epoch} ))
        if [ "$unchanged_for" -lt "$threshold" ] || [ "${notified_idle[$key]:-0}" -eq 1 ]
        then
            continue
        fi

        if [ "$pane" == "captain:0" ]
        then
            log "HEARTBEAT: Captain pane idle for ${HEARTBEAT_THRESHOLD}s — injecting nudge"
            tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. Refer to your skills for the specifics. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.' 2>/dev/null
        else
            log "IDLE ALERT: Worker $pane idle for ${WORKER_THRESHOLD}s — notifying captain"
            tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                "IDLE ALERT: Worker $pane has been idle for ${WORKER_THRESHOLD} seconds. Please check on this worker. Look at relevant skills for specific things to check, ways to verify, re-task, clean up, and archive completed workers, and so on. Don't forget to report any concrete developments via text-to-speech." 2>/dev/null
        fi

        sleep 0.5
        tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 Enter 2>/dev/null

        notified_idle[$key]=1
    done < <(
        echo "$CAPTAIN_TMUX_SOCKET" captain:0
        tmux -S "$WORKSPACE_TMUX_SOCKET" list-panes -a -F '#{session_name}:#{window_index}' 2>/dev/null \
            | while read -r pane; do echo "$WORKSPACE_TMUX_SOCKET" "$pane"; done
    )

    sleep 1
done
