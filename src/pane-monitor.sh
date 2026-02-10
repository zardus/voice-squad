#!/bin/bash
# pane-monitor.sh — Unified monitor for all tmux panes (captain + workers).
#
# Captain pane (captain:0): 300-second idle threshold → injects HEARTBEAT nudge
# Worker panes (everything else): 30-second idle threshold → sends IDLE ALERT to captain
#
# Checks every 1 second, tracks per-pane state via content hashing.
# One-shot notification per idle period; resets when activity resumes.
# Dynamically discovers new/killed sessions/windows.

CAPTAIN_PANE="captain:0"
CAPTAIN_THRESHOLD=300   # 5 minutes
WORKER_THRESHOLD=30     # 30 seconds

LOGFILE="/tmp/pane-monitor.log"

declare -A last_hash
declare -A seconds_unchanged
declare -A already_notified
declare -A has_had_activity

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Pane monitor started (pid=$$, captain_threshold=${CAPTAIN_THRESHOLD}s, worker_threshold=${WORKER_THRESHOLD}s)"

while true; do
    # Discover all current panes across all sessions
    current_panes=()
    while IFS= read -r pane_target; do
        [[ -z "$pane_target" ]] && continue
        current_panes+=("$pane_target")
    done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)

    # Build a set for quick lookup
    declare -A current_set
    for p in "${current_panes[@]}"; do
        current_set["$p"]=1
    done

    # Clean up tracking for panes that no longer exist
    for tracked in "${!last_hash[@]}"; do
        if [[ -z "${current_set[$tracked]}" ]]; then
            log "Pane $tracked gone — removing from tracking"
            unset last_hash["$tracked"]
            unset seconds_unchanged["$tracked"]
            unset already_notified["$tracked"]
            unset has_had_activity["$tracked"]
        fi
    done

    # Check each pane
    for pane in "${current_panes[@]}"; do
        # Determine if this is the captain pane or a worker pane
        # Captain pane is captain:0.0 (session captain, window 0, pane 0)
        if [[ "$pane" == captain:0.* ]]; then
            threshold=$CAPTAIN_THRESHOLD
            is_captain=1
        elif [[ "$pane" == captain:* ]]; then
            # Other windows in the captain session (voice, monitor) — skip
            continue
        else
            threshold=$WORKER_THRESHOLD
            is_captain=0
        fi

        # Capture pane content and hash it
        content_hash=$(tmux capture-pane -t "$pane" -p 2>/dev/null | md5sum | cut -d' ' -f1)
        if [[ -z "$content_hash" ]]; then
            continue
        fi

        prev_hash="${last_hash[$pane]:-}"

        if [[ -z "$prev_hash" ]]; then
            # New pane — start tracking
            last_hash["$pane"]="$content_hash"
            seconds_unchanged["$pane"]=0
            already_notified["$pane"]=0
            has_had_activity["$pane"]=0
            log "Now tracking pane $pane (threshold=${threshold}s)"
            continue
        fi

        if [[ "$content_hash" == "$prev_hash" ]]; then
            seconds_unchanged["$pane"]=$(( ${seconds_unchanged[$pane]} + 1 ))

            # Check idle threshold (workers require prior activity; captain always eligible)
            if (( seconds_unchanged[$pane] >= threshold )) && \
               (( already_notified[$pane] == 0 )) && \
               (( is_captain == 1 || has_had_activity[$pane] == 1 )); then

                if (( is_captain )); then
                    # Captain stale — inject heartbeat nudge directly into captain pane
                    log "HEARTBEAT: Captain pane idle for ${threshold}s — injecting nudge"
                    tmux send-keys -t "$CAPTAIN_PANE" \
                        'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.' 2>/dev/null || true
                    sleep 1
                    tmux send-keys -t "$CAPTAIN_PANE" Enter 2>/dev/null || true
                    log "Heartbeat injected. Resetting counter."
                else
                    # Worker idle — alert the captain
                    sw="${pane%.*}"   # drop .pane_index → session:window
                    log "IDLE ALERT: Worker $sw idle for ${threshold}s — notifying captain"
                    tmux send-keys -t "$CAPTAIN_PANE" \
                        "IDLE ALERT: Worker $sw has been idle for ${threshold} seconds" Enter 2>/dev/null || true
                fi

                already_notified["$pane"]=1
                # Reset hash so we re-trigger if still idle after another full threshold
                seconds_unchanged["$pane"]=0
                prev_hash=""
                last_hash["$pane"]=""
            fi
        else
            # Content changed — activity detected
            last_hash["$pane"]="$content_hash"
            seconds_unchanged["$pane"]=0
            already_notified["$pane"]=0
            has_had_activity["$pane"]=1
        fi
    done

    unset current_set
    sleep 1
done
