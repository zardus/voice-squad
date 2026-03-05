#!/bin/bash
# pane-monitor.sh — Monitor all tmux panes (captain heartbeat + worker idle detection).
#
# Captain pane (captain:0): configurable idle threshold → injects HEARTBEAT nudge
# Worker panes (on project tmux servers): 30-second idle threshold → sends IDLE ALERT to captain
#
# Checks every 1 second, tracks per-pane state via content hashing.
# One-shot notification per idle period; resets when activity resumes.
# Dynamically discovers new/killed project containers.
#
# Environment:
#   CAPTAIN_TMUX_SOCKET       — socket path for captain tmux server (for sending alerts + monitoring captain)
#   PROJECTS_SOCKETS_DIR      — directory containing per-project socket dirs (default: /run/squad-sockets/projects)
#   HEARTBEAT_INTERVAL_SECONDS — captain heartbeat threshold in seconds (default: 900 = 15 minutes)

WORKER_THRESHOLD=30     # 30 seconds
HEARTBEAT_THRESHOLD="${HEARTBEAT_INTERVAL_SECONDS:-900}"
PROJECTS_SOCKETS_DIR="${PROJECTS_SOCKETS_DIR:-/run/squad-sockets/projects}"
LOGFILE="/tmp/pane-monitor.log"

set -o pipefail

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Pane monitor started (pid=$$, worker_threshold=${WORKER_THRESHOLD}s, heartbeat_threshold=${HEARTBEAT_THRESHOLD}s)"

declare -A last_hash=( )
declare -A last_change_epoch=( )
declare -A notified_idle=( )

# Each line from the pane enumeration has 3 fields: socket tmux_target display_name
# For captain: CAPTAIN_SOCKET captain:0 captain:0
# For projects: /path/to/socket agents:0 projectName/agents:0

while true
do
    while read -r socket tmux_target display_name
    do
        key="${socket}|${display_name}"
        now_epoch=$(date +%s)

        if [ "$display_name" == "captain:0" ]; then
            threshold="$HEARTBEAT_THRESHOLD"
        else
            threshold="$WORKER_THRESHOLD"
        fi

        pane_hash=$(tmux -S "$socket" capture-pane -t "$tmux_target" -p 2>/dev/null | md5sum) || continue
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

        if [ "$display_name" == "captain:0" ]
        then
            log "HEARTBEAT: Captain pane idle for ${HEARTBEAT_THRESHOLD}s — injecting nudge"
            tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. Use list-workers to see all workers, capture-worker-output to check their status, send-keys-to-worker to nudge stuck ones, and archive-worker to clean up completed tasks. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.' 2>/dev/null
        else
            log "IDLE ALERT: Worker $display_name idle for ${WORKER_THRESHOLD}s — notifying captain"
            tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 \
                "IDLE ALERT: Worker $display_name has been idle for ${WORKER_THRESHOLD} seconds. Please check on this worker using capture-worker-output to see its status. If it is finished, verify its work and use archive-worker to clean it up. If it is stuck, use send-keys-to-worker to nudge it. Don't forget to report any concrete developments via text-to-speech." 2>/dev/null
        fi

        sleep 0.5
        tmux -S "$CAPTAIN_TMUX_SOCKET" send-keys -t captain:0 Enter 2>/dev/null

        notified_idle[$key]=1
    done < <(
        echo "$CAPTAIN_TMUX_SOCKET captain:0 captain:0"
        for socket in "$PROJECTS_SOCKETS_DIR"/*/default; do
            [ -S "$socket" ] || continue
            project_name=$(basename "$(dirname "$socket")")
            tmux -S "$socket" list-panes -a -F '#{session_name}:#{window_index}' 2>/dev/null \
                | while read -r pane; do echo "$socket $pane ${project_name}/${pane}"; done
        done
    )

    sleep 1
done
