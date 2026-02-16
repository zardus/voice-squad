#!/bin/bash
# pane-monitor.sh — Monitor worker tmux panes for idle detection.
#
# Worker panes (on workspace tmux server): 30-second idle threshold → sends IDLE ALERT to captain
#
# Captain monitoring is no longer needed — the captain runs in its own container.
#
# Checks every 1 second, tracks per-pane state via content hashing.
# One-shot notification per idle period; resets when activity resumes.
# Dynamically discovers new/killed sessions/windows.
#
# Environment:
#   CAPTAIN_TMUX_SOCKET   — socket path for captain tmux server (for sending alerts)
#   WORKSPACE_TMUX_SOCKET — socket path for workspace tmux server (for monitoring workers)

WORKER_THRESHOLD=30     # 30 seconds

LOGFILE="/tmp/pane-monitor.log"

# Build tmux command helpers for each socket
captain_tmux() {
    if [ -n "${CAPTAIN_TMUX_SOCKET:-}" ]; then
        tmux -S "$CAPTAIN_TMUX_SOCKET" "$@"
    else
        tmux "$@"
    fi
}

workspace_tmux() {
    if [ -n "${WORKSPACE_TMUX_SOCKET:-}" ]; then
        tmux -S "$WORKSPACE_TMUX_SOCKET" "$@"
    else
        tmux "$@"
    fi
}

declare -A last_hash
declare -A seconds_unchanged
declare -A already_notified
declare -A has_had_activity

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Pane monitor started (pid=$$, worker_threshold=${WORKER_THRESHOLD}s)"

while true; do
    # Discover all current panes on the WORKSPACE tmux server (workers only)
    current_panes=()
    while IFS= read -r pane_target; do
        [[ -z "$pane_target" ]] && continue
        current_panes+=("$pane_target")
    done < <(workspace_tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)

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
        # All panes on the workspace server are workers
        threshold=$WORKER_THRESHOLD

        # Capture pane content and hash it
        content_hash=$(workspace_tmux capture-pane -t "$pane" -p 2>/dev/null | md5sum | cut -d' ' -f1)
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

            # Check idle threshold (workers require prior activity)
            if (( seconds_unchanged[$pane] >= threshold )) && \
               (( already_notified[$pane] == 0 )) && \
               (( has_had_activity[$pane] == 1 )); then

                # Worker idle — alert the captain
                sw="${pane%.*}"   # drop .pane_index → session:window
                log "IDLE ALERT: Worker $sw idle for ${threshold}s — notifying captain"
                captain_tmux send-keys -t captain:0 \
                    "IDLE ALERT: Worker $sw has been idle for ${threshold} seconds" 2>/dev/null || true
                sleep 0.5
                captain_tmux send-keys -t captain:0 Enter 2>/dev/null || true

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
