#!/bin/bash
# idle-monitor.sh — Monitors worker tmux panes for idle state and notifies the captain.
# Runs in a loop, checking every 1 second. Pure bash + tmux + md5sum.

IDLE_THRESHOLD=30  # seconds unchanged before considered idle

declare -A last_hash
declare -A seconds_unchanged
declare -A already_notified
declare -A has_had_activity

while true; do
    # Discover all current pane targets, excluding the "captain" session
    current_panes=()
    while IFS= read -r pane_target; do
        [[ -z "$pane_target" ]] && continue
        current_panes+=("$pane_target")
    done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | grep -v '^captain:')

    # Build a set of current pane targets for quick lookup
    declare -A current_set
    for p in "${current_panes[@]}"; do
        current_set["$p"]=1
    done

    # Clean up tracking for panes that no longer exist
    for tracked in "${!last_hash[@]}"; do
        if [[ -z "${current_set[$tracked]}" ]]; then
            unset last_hash["$tracked"]
            unset seconds_unchanged["$tracked"]
            unset already_notified["$tracked"]
            unset has_had_activity["$tracked"]
        fi
    done

    # Check each current pane
    for pane in "${current_panes[@]}"; do
        # Capture pane content and hash it; skip on error (pane may have just died)
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
            continue
        fi

        if [[ "$content_hash" == "$prev_hash" ]]; then
            seconds_unchanged["$pane"]=$(( ${seconds_unchanged[$pane]} + 1 ))

            # Check idle threshold
            if (( seconds_unchanged[$pane] >= IDLE_THRESHOLD )) && \
               (( has_had_activity[$pane] == 1 )) && \
               (( already_notified[$pane] == 0 )); then
                # Extract session:window for the alert (drop .pane_index)
                sw="${pane%.*}"
                tmux send-keys -t captain:0 "IDLE ALERT: Worker $sw has been idle for ${IDLE_THRESHOLD} seconds" Enter 2>/dev/null || true
                already_notified["$pane"]=1
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
