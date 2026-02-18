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

declare -A seconds_unchanged=( )
declare -A last_hash=( )
declare -A thresholds=( ['captain:0']=$HEARTBEAT_THRESHOLD )

while true
do
    while read -r -a LINE
    do
        socket=${LINE[0]}
        pane=${LINE[1]}
        pane_hash=$(tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null | md5sum) || continue
        if [ "${last_hash[$pane]}" == "$pane_hash" ]
        then
            (( seconds_unchanged[$pane]++ ))
        else
            (( seconds_unchanged[$pane] = 0 ))
            last_hash[$pane]="$pane_hash"
        fi

        if [ "${seconds_unchanged[$pane]}" -eq "${thresholds[$pane]:-$WORKER_THRESHOLD}" ]
        then
            if [ "$pane" == "captain:0" ]
            then
                log "HEARTBEAT: Captain pane idle for ${HEARTBEAT_THRESHOLD}s — injecting nudge"
                tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                    'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.' 2>/dev/null
            else
                log "IDLE ALERT: Worker $pane idle for ${WORKER_THRESHOLD}s — notifying captain"
                tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                    "IDLE ALERT: Worker $pane has been idle for ${WORKER_THRESHOLD} seconds" 2>/dev/null
            fi

            sleep 0.5
            tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 Enter 2>/dev/null
        fi
    done < <(
        echo "$CAPTAIN_TMUX_SOCKET" captain:0
        tmux -S "$WORKSPACE_TMUX_SOCKET" list-panes -a -F '#{session_name}:#{window_index}' 2>/dev/null
    )

    sleep 1
done
