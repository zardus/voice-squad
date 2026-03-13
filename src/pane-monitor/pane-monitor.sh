#!/bin/bash
# pane-monitor.sh — Monitor all tmux panes (overseer heartbeat + worker idle detection).
#
# Overseer pane (overseer:0): configurable idle threshold → injects HEARTBEAT nudge
# Worker panes (on project tmux servers):
#   30-second idle threshold → sends alert to overseer for nudging
#   60-second idle threshold → alerts human via speak
#
# Checks every 1 second, tracks per-pane state via content hashing.
# One-shot notification per idle period; resets when activity resumes.
# Dynamically discovers new/killed project containers.
#
# Environment:
#   OVERSEER_TMUX_SOCKET       — socket path for overseer tmux server
#   PROJECTS_SOCKETS_DIR       — directory containing per-project socket dirs (default: /run/squad/tmux/projects)
#   HEARTBEAT_INTERVAL_SECONDS — overseer heartbeat threshold in seconds (default: 900 = 15 minutes)
#   SPEAK_SOCKET_PATH          — unix socket for speak/TTS (default: /run/squad/speak.sock)

WORKER_OVERSEER_THRESHOLD=30   # 30 seconds — notify overseer
WORKER_HUMAN_THRESHOLD=60      # 60 seconds — notify human via speak
HEARTBEAT_THRESHOLD="${HEARTBEAT_INTERVAL_SECONDS:-900}"
PROJECTS_SOCKETS_DIR="${PROJECTS_SOCKETS_DIR:-/run/squad/tmux/projects}"
OVERSEER_TMUX_SOCKET="${OVERSEER_TMUX_SOCKET:-/run/squad/tmux/overseer/default}"
SPEAK_SOCKET_PATH="${SPEAK_SOCKET_PATH:-/run/squad/speak.sock}"
LOGFILE="/tmp/pane-monitor.log"

set -o pipefail

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

speak_to_human() {
    if [ -S "$SPEAK_SOCKET_PATH" ]; then
        curl -s --unix-socket "$SPEAK_SOCKET_PATH" -X POST -H "Content-Type: application/json" \
            -d "{\"text\": \"$1\"}" http://localhost/speak > /dev/null 2>&1 || true
    fi
}

log "Pane monitor started (pid=$$, overseer_threshold=${WORKER_OVERSEER_THRESHOLD}s, human_threshold=${WORKER_HUMAN_THRESHOLD}s, heartbeat_threshold=${HEARTBEAT_THRESHOLD}s)"

declare -A last_hash=( )
declare -A last_change_epoch=( )
declare -A notified_overseer=( )
declare -A notified_human=( )

while true
do
    while read -r socket tmux_target display_name
    do
        key="${socket}|${display_name}"
        now_epoch=$(date +%s)

        pane_hash=$(tmux -S "$socket" capture-pane -t "$tmux_target" -p 2>/dev/null | md5sum) || continue
        if [ "${last_hash[$key]:-}" != "$pane_hash" ]
        then
            last_hash[$key]="$pane_hash"
            last_change_epoch[$key]="$now_epoch"
            notified_overseer[$key]=0
            notified_human[$key]=0
            continue
        fi

        unchanged_for=$(( now_epoch - ${last_change_epoch[$key]:-$now_epoch} ))

        if [ "$display_name" == "overseer:0" ]
        then
            # Overseer heartbeat (same as before)
            if [ "$unchanged_for" -ge "$HEARTBEAT_THRESHOLD" ] && [ "${notified_overseer[$key]:-0}" -eq 0 ]; then
                log "HEARTBEAT: Overseer pane idle for ${HEARTBEAT_THRESHOLD}s — injecting nudge"
                tmux -S "$OVERSEER_TMUX_SOCKET" send-keys -t overseer:0 \
                    'HEARTBEAT MESSAGE: please check on all active workers. Use list-workers to see all workers, capture-worker-output to check their status. If any workers are idle or stuck, nudge them with send-keys-to-worker. If workers are finished, verify and archive them. If there are concrete developments worth reporting, use speak to give the human a voice update.' 2>/dev/null
                sleep 0.5
                tmux -S "$OVERSEER_TMUX_SOCKET" send-keys -t overseer:0 Enter 2>/dev/null
                notified_overseer[$key]=1
            fi
        else
            # Worker pane — two-tier notification

            # Tier 1: 30s idle → notify overseer for nudging
            if [ "$unchanged_for" -ge "$WORKER_OVERSEER_THRESHOLD" ] && [ "${notified_overseer[$key]:-0}" -eq 0 ]; then
                log "IDLE ALERT (overseer): Worker $display_name idle for ${WORKER_OVERSEER_THRESHOLD}s — notifying overseer"
                tmux -S "$OVERSEER_TMUX_SOCKET" send-keys -t overseer:0 \
                    "IDLE ALERT: Worker $display_name has been idle for ${WORKER_OVERSEER_THRESHOLD} seconds. Check on it using capture-worker-output. If it is finished, verify and archive it. If it is being lazy or just stopped, nudge it with send-keys-to-worker. Do NOT make decisions for it — only nudge if it seems to have stopped working without reason." 2>/dev/null
                sleep 0.5
                tmux -S "$OVERSEER_TMUX_SOCKET" send-keys -t overseer:0 Enter 2>/dev/null
                notified_overseer[$key]=1
            fi

            # Tier 2: 60s idle → notify human via speak
            if [ "$unchanged_for" -ge "$WORKER_HUMAN_THRESHOLD" ] && [ "${notified_human[$key]:-0}" -eq 0 ]; then
                log "IDLE ALERT (human): Worker $display_name idle for ${WORKER_HUMAN_THRESHOLD}s — alerting human via speak"
                speak_to_human "Worker $display_name has been idle for over a minute. It may need your attention."
                notified_human[$key]=1
            fi
        fi

    done < <(
        echo "$OVERSEER_TMUX_SOCKET overseer:0 overseer:0"
        for socket in "$PROJECTS_SOCKETS_DIR"/*/default; do
            [ -S "$socket" ] || continue
            project_name=$(basename "$(dirname "$socket")")
            tmux -S "$socket" list-panes -a -F '#{session_name}:#{window_index} #{window_name}' 2>/dev/null \
                | while read -r pane wname; do
                    [ "$wname" = "PLACEHOLDER" ] && continue
                    echo "$socket $pane ${project_name}/${pane}"
                done
        done
    )

    sleep 1
done
