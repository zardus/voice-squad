#!/usr/bin/env python3
"""FUSE Auth Proxy — transparently routes credential file reads/writes
to per-account backing files based on the calling process's PID.

Mounts over ~/.claude/ or ~/.codex/ and intercepts reads/writes to
credential files, routing them to the correct account profile directory.
Non-credential files pass through to a shared backing store.

PID-to-account mapping is managed via a JSON file at /run/fuse-auth-proxy/pid-map.json
and a Unix domain socket at /run/fuse-auth-proxy/control.sock for registration.
"""

import errno
import json
import logging
import os
import shlex
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    from fuse import FUSE, FuseOSError, Operations
except ImportError:
    print("ERROR: fusepy not installed. Install with: pip3 install fusepy", file=sys.stderr)
    sys.exit(1)

LOG_FORMAT = "[fuse-auth-proxy] %(asctime)s %(levelname)s %(message)s"
logging.basicConfig(format=LOG_FORMAT, level=os.environ.get("FUSE_AUTH_LOG_LEVEL", "INFO").upper())
log = logging.getLogger("fuse-auth-proxy")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RUN_DIR = os.environ.get("FUSE_AUTH_RUN_DIR", "/run/fuse-auth-proxy")
PID_MAP_FILE = os.path.join(RUN_DIR, "pid-map.json")
CONTROL_SOCKET = os.path.join(RUN_DIR, "control.sock")
PROFILES_DIR = os.environ.get(
    "FUSE_AUTH_PROFILES_DIR",
    os.path.expanduser("~/captain/auth/profiles"),
)
DEFAULT_ACCOUNT = os.environ.get("FUSE_AUTH_DEFAULT_ACCOUNT", "default")

# Credential files that get per-account routing
CLAUDE_CRED_FILES = {".credentials.json"}
CODEX_CRED_FILES = {"auth.json"}

# ---------------------------------------------------------------------------
# PID Map Manager
# ---------------------------------------------------------------------------


class PidMapManager:
    """Thread-safe PID-to-account mapping with file persistence."""

    def __init__(self, pid_map_file: str):
        self._file = pid_map_file
        self._lock = threading.Lock()
        self._map: dict[int, str] = {}
        self._load()

    def _load(self):
        try:
            with open(self._file) as f:
                raw = json.load(f)
            self._map = {int(k): v for k, v in raw.items()}
        except (FileNotFoundError, json.JSONDecodeError, ValueError):
            self._map = {}

    def _save(self):
        os.makedirs(os.path.dirname(self._file), exist_ok=True)
        tmp = self._file + ".tmp"
        with open(tmp, "w") as f:
            json.dump({str(k): v for k, v in self._map.items()}, f, indent=2)
        os.replace(tmp, self._file)

    def register(self, pid: int, account: str):
        with self._lock:
            self._map[pid] = account
            self._save()
        log.info("Registered PID %d -> account '%s'", pid, account)

    def unregister(self, pid: int):
        with self._lock:
            removed = self._map.pop(pid, None)
            if removed:
                self._save()
                log.info("Unregistered PID %d (was account '%s')", pid, removed)

    def lookup(self, pid: int) -> str:
        """Look up account for a PID, walking up the process tree."""
        with self._lock:
            visited = set()
            current = pid
            while current and current not in visited:
                if current in self._map:
                    return self._map[current]
                visited.add(current)
                current = _get_ppid(current)
            return DEFAULT_ACCOUNT

    def cleanup_stale(self):
        """Remove entries for PIDs that no longer exist."""
        with self._lock:
            stale = [pid for pid in self._map if not _pid_exists(pid)]
            for pid in stale:
                log.info("Cleaning stale PID %d (account '%s')", pid, self._map[pid])
                del self._map[pid]
            if stale:
                self._save()

    def list_all(self) -> dict[int, str]:
        with self._lock:
            return dict(self._map)


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _get_ppid(pid: int) -> int:
    """Get parent PID from /proc."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().split(")")
            fields = parts[-1].split()
            # After splitting on ")", fields[0] is state, fields[1] is ppid
            # (field index 3 of the full stat line: pid, comm, state, ppid)
            return int(fields[1])
    except (FileNotFoundError, IndexError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Credential FUSE Filesystem
# ---------------------------------------------------------------------------


class CredentialFS(Operations):
    """FUSE filesystem that routes credential file access per-PID.

    Args:
        tool: "claude" or "codex"
        backing_dir: shared backing directory (original contents of the mount point)
        profiles_dir: root of per-account profile directories
        pid_map: PidMapManager instance
        cred_files: set of filenames that get per-account routing
    """

    def __init__(
        self,
        tool: str,
        backing_dir: str,
        profiles_dir: str,
        pid_map: PidMapManager,
        cred_files: set[str],
    ):
        self.tool = tool
        self.backing_dir = backing_dir
        self.profiles_dir = profiles_dir
        self.pid_map = pid_map
        self.cred_files = cred_files
        self._init_lock = threading.Lock()

    def _real_path(self, path: str, pid: int | None = None) -> str:
        """Resolve a FUSE path to its real backing file.

        For credential files, routes to the account-specific profile.
        For everything else, uses the shared backing directory.
        """
        # Strip leading /
        rel = path.lstrip("/")
        basename = os.path.basename(rel)

        if basename in self.cred_files:
            if pid is None:
                try:
                    pid = self._get_caller_pid()
                except Exception:
                    pid = 0
            account = self.pid_map.lookup(pid)
            log.debug("_real_path: %s pid=%d -> account=%s", path, pid, account)
            profile_path = os.path.join(
                self.profiles_dir, account, self.tool, rel
            )
            # Ensure the profile directory exists and initialize the file if needed
            self._ensure_profile_file(profile_path, rel)
            return profile_path
        else:
            return os.path.join(self.backing_dir, rel)

    def _ensure_profile_file(self, profile_path: str, rel: str):
        """Ensure profile credential file exists, with locking to prevent races."""
        if os.path.exists(profile_path):
            return
        with self._init_lock:
            # Double-check after acquiring lock
            if os.path.exists(profile_path):
                return
            os.makedirs(os.path.dirname(profile_path), exist_ok=True)
            backing = os.path.join(self.backing_dir, rel)
            if os.path.exists(backing):
                shutil.copy2(backing, profile_path)
            else:
                with open(profile_path, "w") as f:
                    f.write("{}")

    def _get_caller_pid(self) -> int:
        """Get the PID of the process making the FUSE request.

        Uses fuse_get_context() which is provided by fusepy.
        """
        try:
            from fuse import fuse_get_context
            uid, gid, pid = fuse_get_context()
            return pid
        except Exception:
            return 0

    # -- Filesystem methods --

    def getattr(self, path, fh=None):
        real = self._real_path(path)
        try:
            st = os.lstat(real)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        return {
            key: getattr(st, key)
            for key in (
                "st_atime",
                "st_ctime",
                "st_gid",
                "st_mode",
                "st_mtime",
                "st_nlink",
                "st_size",
                "st_uid",
            )
        }

    def readdir(self, path, fh):
        # Use backing_dir directly for directory listings: all PIDs see the same
        # directory entries — only individual file *contents* differ per-account.
        real = os.path.join(self.backing_dir, path.lstrip("/"))
        entries = [".", ".."]
        if os.path.isdir(real):
            entries.extend(os.listdir(real))
        return entries

    def open(self, path, flags):
        real = self._real_path(path)
        try:
            return os.open(real, flags)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)
        except PermissionError:
            raise FuseOSError(errno.EACCES)

    def create(self, path, mode, fi=None):
        real = self._real_path(path)
        os.makedirs(os.path.dirname(real), exist_ok=True)
        try:
            return os.open(real, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        except FileExistsError:
            raise FuseOSError(errno.EEXIST)

    def read(self, path, length, offset, fh):
        os.lseek(fh, offset, os.SEEK_SET)
        return os.read(fh, length)

    def write(self, path, buf, offset, fh):
        os.lseek(fh, offset, os.SEEK_SET)
        return os.write(fh, buf)

    def truncate(self, path, length, fh=None):
        if fh is not None:
            os.ftruncate(fh, length)
        else:
            real = self._real_path(path)
            os.truncate(real, length)

    def flush(self, path, fh):
        os.fsync(fh)

    def release(self, path, fh):
        os.close(fh)

    def fsync(self, path, fdatasync, fh):
        os.fsync(fh)

    def chmod(self, path, mode):
        real = self._real_path(path)
        try:
            os.chmod(real, mode)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)

    def chown(self, path, uid, gid):
        real = self._real_path(path)
        try:
            os.chown(real, uid, gid)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)

    def mkdir(self, path, mode):
        real = os.path.join(self.backing_dir, path.lstrip("/"))
        try:
            os.makedirs(real, mode=mode, exist_ok=True)
        except PermissionError:
            raise FuseOSError(errno.EACCES)

    def rmdir(self, path):
        real = os.path.join(self.backing_dir, path.lstrip("/"))
        try:
            os.rmdir(real)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        except OSError as e:
            raise FuseOSError(e.errno or errno.EIO)

    def unlink(self, path):
        real = self._real_path(path)
        try:
            os.unlink(real)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)
        except PermissionError:
            raise FuseOSError(errno.EACCES)

    def rename(self, old, new):
        real_old = os.path.join(self.backing_dir, old.lstrip("/"))
        real_new = os.path.join(self.backing_dir, new.lstrip("/"))
        try:
            os.rename(real_old, real_new)
        except FileNotFoundError:
            raise FuseOSError(errno.ENOENT)
        except PermissionError:
            raise FuseOSError(errno.EACCES)
        except FileExistsError:
            raise FuseOSError(errno.EEXIST)

    def utimens(self, path, times=None):
        real = self._real_path(path)
        os.utime(real, times)

    def statfs(self, path):
        real = self._real_path(path)
        stv = os.statvfs(real)
        return {
            key: getattr(stv, key)
            for key in (
                "f_bavail",
                "f_bfree",
                "f_blocks",
                "f_bsize",
                "f_favail",
                "f_ffree",
                "f_files",
                "f_flag",
                "f_frsize",
                "f_namemax",
            )
        }

    def readlink(self, path):
        real = os.path.join(self.backing_dir, path.lstrip("/"))
        return os.readlink(real)

    def symlink(self, name, target):
        real_name = os.path.join(self.backing_dir, name.lstrip("/"))
        os.symlink(target, real_name)

    def link(self, target, name):
        real_target = os.path.join(self.backing_dir, target.lstrip("/"))
        real_name = os.path.join(self.backing_dir, name.lstrip("/"))
        os.link(real_target, real_name)

    def access(self, path, mode):
        real = self._real_path(path)
        if not os.access(real, mode):
            raise FuseOSError(errno.EACCES)


# ---------------------------------------------------------------------------
# Control Socket Server
# ---------------------------------------------------------------------------


class ControlServer:
    """Unix socket server for PID registration commands.

    Protocol: newline-delimited JSON messages.

    Commands:
        {"cmd": "register", "pid": 1234, "account": "alice"}
        {"cmd": "unregister", "pid": 1234}
        {"cmd": "list"}
        {"cmd": "cleanup"}
        {"cmd": "query", "pid": 1234}
    """

    def __init__(self, socket_path: str, pid_map: PidMapManager, allowed_uid: int | None = None):
        self.socket_path = socket_path
        self.pid_map = pid_map
        self._server = None
        self._thread = None
        self._allowed_uid = allowed_uid

    def start(self):
        os.makedirs(os.path.dirname(self.socket_path), exist_ok=True)
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(self.socket_path)
        # Restrict socket to owner only (captain process runs as same user)
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError as e:
            log.warning("Could not set control socket permissions: %s", e)
        self._server.listen(5)
        self._server.settimeout(1.0)

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        log.info("Control socket listening at %s", self.socket_path)

    def _run(self):
        while True:
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _verify_peer(self, conn: socket.socket) -> bool:
        """Verify connecting peer via SO_PEERCRED (Linux only)."""
        if self._allowed_uid is None:
            return True
        try:
            cred = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
            peer_pid, peer_uid, peer_gid = struct.unpack("iII", cred)
            if peer_uid != self._allowed_uid:
                log.warning("Rejected connection from UID %d (expected %d)", peer_uid, self._allowed_uid)
                return False
            return True
        except (OSError, struct.error) as e:
            log.warning("SO_PEERCRED check failed: %s — allowing connection", e)
            return True

    def _handle(self, conn: socket.socket):
        try:
            if not self._verify_peer(conn):
                conn.sendall(b'{"ok":false,"error":"permission denied"}\n')
                return

            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in data:
                    break

            for line in data.decode().strip().split("\n"):
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    resp = self._dispatch(msg)
                except json.JSONDecodeError as e:
                    resp = {"ok": False, "error": f"Invalid JSON: {e}"}
                conn.sendall((json.dumps(resp) + "\n").encode())
        except Exception as e:
            log.error("Control socket handler error: %s", e)
        finally:
            conn.close()

    def _dispatch(self, msg: dict) -> dict:
        cmd = msg.get("cmd", "")
        if cmd == "register":
            pid = msg.get("pid")
            account = msg.get("account")
            if not pid or not account:
                return {"ok": False, "error": "Missing pid or account"}
            self.pid_map.register(int(pid), str(account))
            return {"ok": True}
        elif cmd == "unregister":
            pid = msg.get("pid")
            if not pid:
                return {"ok": False, "error": "Missing pid"}
            self.pid_map.unregister(int(pid))
            return {"ok": True}
        elif cmd == "list":
            return {"ok": True, "mappings": {str(k): v for k, v in self.pid_map.list_all().items()}}
        elif cmd == "cleanup":
            self.pid_map.cleanup_stale()
            return {"ok": True}
        elif cmd == "query":
            pid = msg.get("pid")
            if not pid:
                return {"ok": False, "error": "Missing pid"}
            account = self.pid_map.lookup(int(pid))
            return {"ok": True, "pid": pid, "account": account}
        else:
            return {"ok": False, "error": f"Unknown command: {cmd}"}

    def stop(self):
        if self._server:
            self._server.close()


# ---------------------------------------------------------------------------
# Stale PID Cleanup Thread
# ---------------------------------------------------------------------------


def stale_cleanup_loop(pid_map: PidMapManager, interval: int = 30):
    """Periodically clean up stale PID entries."""
    while True:
        time.sleep(interval)
        try:
            pid_map.cleanup_stale()
        except Exception as e:
            log.error("Stale cleanup error: %s", e)


# ---------------------------------------------------------------------------
# Mount Manager
# ---------------------------------------------------------------------------


def prepare_backing_dir(mount_point: str, tool: str) -> str:
    """Move original mount point contents to a backing directory."""
    backing = os.path.join(RUN_DIR, f"backing-{tool}")
    if os.path.exists(backing):
        return backing

    os.makedirs(backing, exist_ok=True)

    # Copy existing files from the mount point to backing
    if os.path.isdir(mount_point):
        for item in os.listdir(mount_point):
            src = os.path.join(mount_point, item)
            dst = os.path.join(backing, item)
            if os.path.isfile(src) or os.path.islink(src):
                shutil.copy2(src, dst, follow_symlinks=False)
            elif os.path.isdir(src):
                shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
    return backing


def mount_fuse(
    tool: str,
    mount_point: str,
    backing_dir: str,
    profiles_dir: str,
    pid_map: PidMapManager,
    cred_files: set[str],
    foreground: bool = False,
) -> None:
    """Mount the FUSE filesystem."""
    fs = CredentialFS(tool, backing_dir, profiles_dir, pid_map, cred_files)
    log.info("Mounting FUSE for %s at %s (backing: %s)", tool, mount_point, backing_dir)
    FUSE(
        fs,
        mount_point,
        nothreads=False,
        foreground=foreground,
        allow_other=True,
        # Make it look like a regular directory, not a FUSE mount
        nonempty=True,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    import argparse

    parser = argparse.ArgumentParser(description="FUSE Auth Proxy for voice-squad")
    parser.add_argument(
        "--tools",
        default=os.environ.get("FUSE_AUTH_TOOLS", "claude,codex"),
        help="Comma-separated list of tools to mount (default: claude,codex)",
    )
    parser.add_argument(
        "--claude-mount",
        default=os.environ.get("FUSE_AUTH_CLAUDE_MOUNT", os.path.expanduser("~/.claude")),
        help="Mount point for Claude credentials",
    )
    parser.add_argument(
        "--codex-mount",
        default=os.environ.get("FUSE_AUTH_CODEX_MOUNT", os.path.expanduser("~/.codex")),
        help="Mount point for Codex credentials",
    )
    parser.add_argument(
        "--foreground", "-f", action="store_true",
        help="Run in foreground",
    )
    args = parser.parse_args()

    os.makedirs(RUN_DIR, exist_ok=True)
    os.makedirs(PROFILES_DIR, exist_ok=True)

    # Initialize PID map
    pid_map = PidMapManager(PID_MAP_FILE)

    # Start control socket — restrict to current user via SO_PEERCRED
    control = ControlServer(CONTROL_SOCKET, pid_map, allowed_uid=os.getuid())
    control.start()

    # Start stale cleanup
    cleanup_thread = threading.Thread(
        target=stale_cleanup_loop, args=(pid_map,), daemon=True
    )
    cleanup_thread.start()

    # Write PID file for healthcheck
    with open(os.path.join(RUN_DIR, "pid"), "w") as f:
        f.write(str(os.getpid()))

    tools = [t.strip() for t in args.tools.split(",") if t.strip()]

    mount_configs = {
        "claude": {
            "mount_point": args.claude_mount,
            "cred_files": CLAUDE_CRED_FILES,
        },
        "codex": {
            "mount_point": args.codex_mount,
            "cred_files": CODEX_CRED_FILES,
        },
    }

    threads = []
    for tool in tools:
        if tool not in mount_configs:
            log.warning("Unknown tool '%s', skipping", tool)
            continue

        cfg = mount_configs[tool]
        mount_point = cfg["mount_point"]

        # Ensure mount point exists
        os.makedirs(mount_point, exist_ok=True)

        # Prepare backing directory
        backing_dir = prepare_backing_dir(mount_point, tool)

        # Mount in a separate thread (FUSE blocks)
        t = threading.Thread(
            target=mount_fuse,
            args=(tool, mount_point, backing_dir, PROFILES_DIR, pid_map, cfg["cred_files"]),
            kwargs={"foreground": True},
            daemon=True,
        )
        t.start()
        threads.append(t)
        log.info("Started FUSE mount thread for %s", tool)

    if not threads:
        log.error("No tools to mount!")
        sys.exit(1)

    # Write ready marker
    with open(os.path.join(RUN_DIR, "ready"), "w") as f:
        f.write("1")
    log.info("FUSE auth proxy ready (tools: %s)", ", ".join(tools))

    # Wait for signal
    def handle_signal(signum, frame):
        log.info("Received signal %d, shutting down...", signum)
        control.stop()
        # Unmount FUSE filesystems
        for tool in tools:
            if tool in mount_configs:
                mp = mount_configs[tool]["mount_point"]
                subprocess.run(
                    ["fusermount", "-u", mp],
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Block main thread
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
