#!/bin/bash
# fuse-auth-register.sh — Register/unregister a worker PID with an account.
#
# Usage:
#   fuse-auth-register.sh register <pid> <account>
#   fuse-auth-register.sh unregister <pid>
#   fuse-auth-register.sh query <pid>
#   fuse-auth-register.sh list
#   fuse-auth-register.sh cleanup
#
# Communicates with the FUSE auth proxy daemon via its control socket.

set -euo pipefail

CONTROL_SOCKET="${FUSE_AUTH_CONTROL_SOCKET:-/run/fuse-auth-proxy/control.sock}"

CMD="${1:-}"
shift || true

usage() {
    echo "Usage: fuse-auth-register.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  register <pid> <account>  — Assign a PID to an account"
    echo "  unregister <pid>          — Remove a PID assignment"
    echo "  query <pid>               — Look up which account a PID is using"
    echo "  list                      — List all PID-to-account mappings"
    echo "  cleanup                   — Remove stale (dead) PID entries"
    exit 1
}

send_cmd() {
    local json="$1"
    if ! [ -S "$CONTROL_SOCKET" ]; then
        echo "ERROR: Control socket not found at $CONTROL_SOCKET" >&2
        echo "Is the FUSE auth proxy running?" >&2
        exit 1
    fi
    # Use socat if available, otherwise python
    if command -v socat &>/dev/null; then
        echo "$json" | socat - UNIX-CONNECT:"$CONTROL_SOCKET"
    elif command -v python3 &>/dev/null; then
        # Pass socket path and JSON via env vars to avoid shell injection
        FUSE_CTL_SOCK="$CONTROL_SOCKET" FUSE_CTL_JSON="$json" python3 -c '
import socket, os, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.environ["FUSE_CTL_SOCK"])
s.sendall(os.environ["FUSE_CTL_JSON"].encode() + b"\n")
s.shutdown(socket.SHUT_WR)
data = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    data += chunk
s.close()
print(data.decode().strip())
'
    else
        echo "ERROR: Need socat or python3 to communicate with control socket" >&2
        exit 1
    fi
}

case "$CMD" in
    register)
        PID="${1:-}"
        ACCOUNT="${2:-}"
        if [ -z "$PID" ] || [ -z "$ACCOUNT" ]; then
            echo "Usage: register <pid> <account>"
            exit 1
        fi
        # Validate PID is a positive integer
        if ! [[ "$PID" =~ ^[1-9][0-9]*$ ]]; then
            echo "ERROR: PID must be a positive integer, got: $PID" >&2
            exit 1
        fi
        # Build JSON safely using jq
        json=$(jq -n --argjson pid "$PID" --arg account "$ACCOUNT" \
            '{"cmd":"register","pid":$pid,"account":$account}')
        send_cmd "$json"
        ;;
    unregister)
        PID="${1:-}"
        if [ -z "$PID" ]; then
            echo "Usage: unregister <pid>"
            exit 1
        fi
        if ! [[ "$PID" =~ ^[1-9][0-9]*$ ]]; then
            echo "ERROR: PID must be a positive integer, got: $PID" >&2
            exit 1
        fi
        json=$(jq -n --argjson pid "$PID" '{"cmd":"unregister","pid":$pid}')
        send_cmd "$json"
        ;;
    query)
        PID="${1:-}"
        if [ -z "$PID" ]; then
            echo "Usage: query <pid>"
            exit 1
        fi
        if ! [[ "$PID" =~ ^[1-9][0-9]*$ ]]; then
            echo "ERROR: PID must be a positive integer, got: $PID" >&2
            exit 1
        fi
        json=$(jq -n --argjson pid "$PID" '{"cmd":"query","pid":$pid}')
        send_cmd "$json"
        ;;
    list)
        send_cmd '{"cmd":"list"}'
        ;;
    cleanup)
        send_cmd '{"cmd":"cleanup"}'
        ;;
    *)
        usage
        ;;
esac
