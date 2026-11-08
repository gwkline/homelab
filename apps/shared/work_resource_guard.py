#!/usr/bin/env python3
"""Opt-in, cooperative work-only disk backpressure and build serialization.

No filesystem quota, sandbox, data cleanup, or protection from detached processes.
Only the supervisor/wrapped command's process group is managed. See the adjacent
work-resource-guard.md for deployment and testing instructions.
"""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import math
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import time

GIB = 1024**3
GUARD_FAILURE = 75
LOCK_OWNER_ENV = "WORK_BUILD_LOCK_OWNER"
TOOLS = ("npm", "npx", "pnpm", "yarn", "bun", "uv", "cargo", "make", "docker", "depot")


def log(message):
    # Never log command arguments, subprocess environments, or exception text.
    print("[work-resource-guard] " + message, file=sys.stderr, flush=True)


def enabled(env):
    return env.get("WORK_RESOURCE_GUARD") == "1" and env.get("WORK_RESOURCE_SCOPE") == "work"


def positive_number(env, key, default):
    value = float(env.get(key, default))
    if not math.isfinite(value) or value <= 0:
        raise ValueError("invalid guard configuration")
    return value


@dataclass(frozen=True)
class Config:
    path: str = "/data"
    lock_path: str = "/data/.work-build.lock"
    start_bytes: int = 25 * GIB
    stop_bytes: int = 20 * GIB
    poll_seconds: float = 2.0
    grace_seconds: float = 5.0

    @classmethod
    def from_env(cls, env):
        start = int(positive_number(env, "WORK_GUARD_START_GIB", 25) * GIB)
        stop = int(positive_number(env, "WORK_GUARD_STOP_GIB", 20) * GIB)
        if start <= stop or stop <= 0:
            raise ValueError("start threshold must exceed stop threshold")
        return cls(
            path=env.get("WORK_GUARD_PATH", "/data"),
            lock_path=env.get("WORK_BUILD_LOCK", "/data/.work-build.lock"),
            start_bytes=start,
            stop_bytes=stop,
            poll_seconds=positive_number(env, "WORK_GUARD_POLL_SECONDS", 2),
            grace_seconds=positive_number(env, "WORK_GUARD_GRACE_SECONDS", 5),
        )


def available_bytes(path, statvfs=os.statvfs):
    """Inject statvfs in tests; f_bavail excludes blocks reserved for root."""
    stat = statvfs(path)
    if stat.f_bavail < 0 or stat.f_frsize <= 0:
        raise OSError("invalid filesystem statistics")
    return stat.f_bavail * stat.f_frsize


def has_space(config, threshold, probe=available_bytes):
    try:
        return probe(config.path) >= threshold
    except (OSError, ValueError, OverflowError):
        log("filesystem statistics unavailable; refusing work")
        return False


@contextmanager
def termination_signals():
    state: list = [None]
    previous = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, lambda number, frame: state.__setitem__(0, number))
    try:
        yield state
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
        return True
    except ProcessLookupError:
        return False


def descendant_groups(pid):
    """Include nested build sessions before terminating their parent wrappers.

    Killing only the server group could kill a build wrapper before it finished
    stopping its own group. Snapshot descendants while their ancestry is intact.
    Only descendant group leaders are included; never signal an ancestor's group.
    """
    rows = []
    try:
        if sys.platform.startswith("linux"):
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    text = (entry / "stat").read_text()
                    fields = text[text.rfind(")") + 2:].split()
                    rows.append((int(entry.name), int(fields[1]), int(fields[2])))
                except (OSError, ValueError, IndexError):
                    continue  # Processes can exit during the snapshot.
        else:
            output = subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,pgid="], stderr=subprocess.DEVNULL, timeout=1,
            )
            rows = [tuple(map(int, line.split())) for line in output.splitlines()]
    except (OSError, ValueError, subprocess.SubprocessError):
        log("descendant snapshot unavailable; managing primary process group only")
    descendants = {pid}
    while True:
        expanded = descendants | {child for child, parent, group in rows if parent in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    return {group for child, parent, group in rows if child == group and child in descendants} | {pid}


def stop_group(process, config, sig=signal.SIGTERM, graceful_leader=False):
    """Grace is bounded even if the leader exits before its descendants."""
    groups = descendant_groups(process.pid)
    if graceful_leader:
        # Entrypoints coordinate their state saver before stopping the server.
        # Stop independently-sessioned builders, then let the leader run its trap.
        for group in groups - {process.pid}:
            signal_group(group, sig)
        try:
            process.send_signal(sig)
        except ProcessLookupError:
            pass
    else:
        for group in groups:
            signal_group(group, sig)
    deadline = time.monotonic() + config.grace_seconds
    while time.monotonic() < deadline:
        process.poll()  # Reap the leader so an empty group disappears promptly.
        if not any(signal_group(group, 0) for group in groups):
            break
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    for group in groups:
        signal_group(group, signal.SIGKILL)
    process.wait()


def shell_status(returncode):
    return returncode if returncode >= 0 else 128 - returncode


def monitor(command, config, env, state, probe=available_bytes, graceful_leader=False):
    """Return (exit status, headroom-triggered stop); never shell-parse argv."""
    if state[0] is not None:
        return 128 + state[0], False
    # Close the lock-acquisition/launch gap and check nested builds too.
    if not has_space(config, config.start_bytes, probe):
        return GUARD_FAILURE, True
    try:
        process = subprocess.Popen(command, env=env, start_new_session=True)
    except OSError:
        log("command could not be started")
        return 127, False
    try:
        while True:
            if state[0] is not None:
                stop_group(process, config, state[0], graceful_leader=graceful_leader)
                return 128 + state[0], False
            status = process.poll()
            if status is not None:
                # Do not leave same-group background writers running after success.
                stop_group(process, config)
                return shell_status(status), False
            if not has_space(config, config.stop_bytes, probe):
                log("headroom below stop threshold; terminating process group")
                stop_group(process, config, graceful_leader=graceful_leader)
                return GUARD_FAILURE, True
            time.sleep(config.poll_seconds)
    finally:
        if process.poll() is None:
            stop_group(process, config)


def supervise(command, config, env=None, probe=available_bytes):
    env = dict(os.environ if env is None else env)
    with termination_signals() as state:
        waiting_logged = False
        while state[0] is None:
            if not has_space(config, config.start_bytes, probe):
                if not waiting_logged:
                    log("server paused; waiting for launch headroom")
                    waiting_logged = True
                time.sleep(config.poll_seconds)
                continue
            log("launch headroom available; starting server")
            waiting_logged = False
            status, low_space = monitor(command, config, env, state, probe, graceful_leader=True)
            if low_space:
                # As container PID 1, exit so the runtime reaps escaped PTY writers.
                # The next container waits for the higher launch watermark.
                return GUARD_FAILURE
            return status
        return 128 + state[0]


def readonly_command(tool, args):
    # Be deliberately conservative: arbitrary scripts and ambiguous flags are heavy.
    if len(args) == 1 and args[0] in ("--version", "-v", "-V", "--help", "-h"):
        return True
    if not args:
        return False
    readonly = {
        "npm": ("help", "view", "info", "list", "ls"),
        "pnpm": ("help", "view", "info", "list", "ls", "why"),
        "yarn": ("help", "info", "list", "why"),
        "bun": ("help",),
        "cargo": ("help", "version", "metadata", "locate-project"),
        "make": (),
        "docker": ("help", "version", "info", "inspect", "ps", "images"),
        "depot": ("help", "version"),
    }
    if args[0] in readonly.get(tool, ()):
        return True
    if tool in ("npm", "pnpm") and args[:2] == ["config", "get"]:
        return True
    return tool == "bun" and args[:2] == ["pm", "ls"]


def build_environment(env):
    result = dict(env)
    result.setdefault("CARGO_BUILD_JOBS", "2")
    options = result.get("NODE_OPTIONS", "")
    try:
        tokens = shlex.split(options)
    except ValueError:
        # Invalid options belong to the caller; do not rewrite or mask them.
        return result
    if not any(token.split("=", 1)[0] in ("--max-old-space-size", "--max_old_space_size") for token in tokens):
        result["NODE_OPTIONS"] = (options + " --max-old-space-size=3072").lstrip()
    return result


def parent_pid(pid):
    """Linux procfs, with a macOS-compatible fallback; never inspect argv."""
    if sys.platform.startswith("linux"):
        try:
            text = Path("/proc/{}/stat".format(pid)).read_text()
            return int(text[text.rfind(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            return None
    try:
        value = subprocess.check_output(
            ["ps", "-o", "ppid=", "-p", str(pid)], stderr=subprocess.DEVNULL, timeout=1,
        )
        return int(value.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def inherited_lock(env, fd):
    """Validate cooperative reentrancy even when Node closes inherited FDs.

    Owner identity must match this exact locked inode and be a live ancestor.
    An env flag alone would bypass unrelated builds or deadlock nested shims.
    This is an operational convention, not a hostile-code security boundary.
    """
    token = env.get(LOCK_OWNER_ENV)
    if not token:
        return False
    try:
        data = json.loads(os.pread(fd, 4096, 0).decode())
        owner = int(data["pid"])
        if data["token"] != token or owner <= 1:
            return False
        pid = os.getppid()
        seen = set()
        while pid and pid > 1 and pid not in seen:
            if pid == owner:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return True
                # Stale metadata is not evidence that the slot is still held.
                fcntl.flock(fd, fcntl.LOCK_UN)
                return False
            seen.add(pid)
            pid = parent_pid(pid)
            if pid is None:
                return None  # A possible nested build must not deadlock its owner.
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        pass
    return False


def serialized_build(command, config, env=None, probe=available_bytes):
    env = build_environment(os.environ if env is None else env)
    with termination_signals() as state:
        try:
            # Do not unlink/replace this shared inode: that would split the mutex.
            fd = os.open(config.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            log("build lock unavailable; refusing work")
            return GUARD_FAILURE
        acquired = False
        try:
            inherited = inherited_lock(env, fd)
            if inherited is None:
                log("nested build ancestry unavailable; refusing work")
                return GUARD_FAILURE
            if inherited:
                log("nested build shares ancestor serialization and monitoring")
                if not has_space(config, config.start_bytes, probe):
                    return GUARD_FAILURE
                # Stay in the outer command's group. A new session here could
                # escape its bounded SIGKILL if the intermediate wrapper died.
                try:
                    os.execvpe(command[0], command, env)
                except OSError:
                    log("command could not be started")
                    return 127
            waiting_logged = False
            while state[0] is None:
                if not has_space(config, config.start_bytes, probe):
                    log("insufficient launch headroom; refusing build")
                    return GUARD_FAILURE
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except BlockingIOError:
                    if not waiting_logged:
                        log("waiting for shared build slot")
                        waiting_logged = True
                    time.sleep(config.poll_seconds)
            if state[0] is not None:
                return 128 + state[0]
            token = secrets.token_hex(16)
            data = json.dumps({"pid": os.getpid(), "token": token}).encode()
            os.ftruncate(fd, 0)
            os.pwrite(fd, data, 0)
            env[LOCK_OWNER_ENV] = token
            log("build slot acquired")
            return monitor(command, config, env, state, probe)[0]
        except OSError:
            log("build lock operation failed; refusing work")
            return GUARD_FAILURE
        finally:
            if acquired:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    run = sub.add_parser("run")
    run.add_argument("command", nargs=argparse.REMAINDER)
    build = sub.add_parser("build")
    build.add_argument("--tool", required=True, choices=TOOLS)
    build.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a real executable and its arguments are required after --")
    env = dict(os.environ)
    if not enabled(env) or (args.mode == "build" and readonly_command(args.tool, command[1:])):
        try:
            os.execvpe(command[0], command, env)
        except OSError:
            log("command could not be started")
            return 127
    try:
        config = Config.from_env(env)
    except (ValueError, OverflowError):
        log("invalid guard configuration; refusing work")
        return GUARD_FAILURE
    if args.mode == "run":
        return supervise(command, config, env)
    return serialized_build(command, config, env)


if __name__ == "__main__":
    sys.exit(main())
