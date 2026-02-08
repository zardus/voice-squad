#!/usr/bin/env bash

LOGFILE="/tmp/heartbeat.log"
PANE="%0"
STALE_THRESHOLD=10
SLEEP_INTERVAL=30

prev_hash=""
stale_count=0

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Heartbeat monitor started (pid=$$, pane=$PANE, threshold=${STALE_THRESHOLD} checks / $((STALE_THRESHOLD * SLEEP_INTERVAL))s)"

while true; do
    sleep "$SLEEP_INTERVAL"

    current_hash=$(tmux capture-pane -t "$PANE" -p 2>/dev/null | md5sum | awk '{print $1}')

    if [[ -z "$current_hash" ]]; then
        log "WARNING: failed to capture pane $PANE"
        stale_count=0
        prev_hash=""
        continue
    fi

    if [[ "$current_hash" == "$prev_hash" ]]; then
        stale_count=$((stale_count + 1))
        log "Pane unchanged (hash=$current_hash, stale_count=$stale_count/$STALE_THRESHOLD)"
    else
        if [[ $stale_count -gt 0 ]]; then
            log "Pane changed after $stale_count stale checks (new hash=$current_hash)"
        else
            log "Pane check OK (hash=$current_hash)"
        fi
        stale_count=0
    fi

    prev_hash="$current_hash"

	if [[ $stale_count -ge $STALE_THRESHOLD ]]; then
	        log "ALERT: $STALE_THRESHOLD consecutive stale checks ($((STALE_THRESHOLD * SLEEP_INTERVAL))s). Injecting heartbeat message."
	        tmux send-keys -t "$PANE" 'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.'
	        sleep 1
	        tmux send-keys -t "$PANE" Enter
	        log "Heartbeat message injected. Resetting counter."
	        stale_count=0
	        prev_hash=""
	fi
done
