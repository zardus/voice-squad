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

# Captain heartbeat state (separate from worker tracking)
captain_last_hash=""
captain_seconds_unchanged=0

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOGFILE"
}

log "Pane monitor started (pid=$$, worker_threshold=${WORKER_THRESHOLD}s, heartbeat_threshold=${HEARTBEAT_THRESHOLD}s)"

while true; do
    # ── Captain heartbeat check ──────────────────────────────────
    # Gate on captain tmux availability — when captain is down (e.g. during
    # container restart), capture-pane fails silently but md5sum hashes the
    # empty output, producing a fake "content" hash that confuses tracking.
    # Skip tracking entirely when captain is unavailable and reset state so
    # the heartbeat counter starts fresh when it comes back.
    if captain_tmux has-session -t captain 2>/dev/null; then
        captain_hash=$(captain_tmux capture-pane -t captain:0 -p 2>/dev/null | md5sum | cut -d' ' -f1)
        if [[ -n "$captain_hash" ]]; then
            if [[ -z "$captain_last_hash" ]]; then
                captain_last_hash="$captain_hash"
            elif [[ "$captain_hash" == "$captain_last_hash" ]]; then
                captain_seconds_unchanged=$(( captain_seconds_unchanged + 1 ))
                if (( captain_seconds_unchanged >= HEARTBEAT_THRESHOLD )); then
                    log "HEARTBEAT: Captain pane idle for ${HEARTBEAT_THRESHOLD}s — injecting nudge"
                    captain_tmux send-keys -t captain:0 \
                        'HEARTBEAT MESSAGE: please do a check of the current tasks and nudge them along or clean them up if reasonable. If there are any concrete developments worth reporting, use the speak command to give the human a voice update via text-to-speech.' 2>/dev/null || true
                    sleep 0.5
                    captain_tmux send-keys -t captain:0 Enter 2>/dev/null || true
                    log "Heartbeat injected. Resetting counter."
                    captain_seconds_unchanged=0
                    captain_last_hash=""
                fi
            else
                captain_last_hash="$captain_hash"
                captain_seconds_unchanged=0
            fi
        fi
    else
        # Captain tmux unavailable — reset so counter starts fresh on reconnect
        if (( captain_seconds_unchanged > 0 )); then
            log "Captain tmux unavailable — resetting heartbeat tracking"
        fi
        captain_last_hash=""
        captain_seconds_unchanged=0
    fi

    # ── Worker idle detection ────────────────────────────────────
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

                # Worker idle — alert the captain (only if captain tmux is reachable)
                sw="${pane%.*}"   # drop .pane_index → session:window
                if captain_tmux has-session -t captain 2>/dev/null; then
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
                else
                    log "IDLE ALERT: Captain tmux unavailable — deferring alert for worker $sw"
                    # Don't update tracking state; will retry on next threshold cycle
                fi
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
