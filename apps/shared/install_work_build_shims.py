#!/usr/bin/env python3
"""Create opt-in command shims without moving their real installations."""

import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import work_resource_guard as guard


def install(root, env, shim):
    if not guard.enabled(env):
        return {}
    root = Path(root)
    if root.is_symlink() or (root / "bin").is_symlink():
        raise ValueError("guard directories must not be symlinks")
    commands = {}
    original_path = env.get("PATH", os.defpath)
    for tool in guard.TOOLS:
        executable = shutil.which(tool, path=original_path)
        if executable:
            # Keep npm launchers and rustup cargo at their original paths.
            commands[tool] = executable
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    bindir = root / "bin"
    bindir.mkdir(mode=0o700, exist_ok=True)
    temporary = root / "commands.json.tmp"
    temporary.write_text(json.dumps(commands))
    temporary.chmod(0o600)
    os.replace(temporary, root / "commands.json")
    for tool in commands:
        link = bindir / tool
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            raise ValueError("unexpected file in generated guard directory")
        link.symlink_to(shim)
    return commands


def main():
    os.umask(0o077)
    shim = str(Path(__file__).with_name("work-build-shim.py"))
    commands = install("/tmp/work-resource-guard", dict(os.environ), shim)
    print("[work-resource-guard] installed command shims: " + str(len(commands)))


if __name__ == "__main__":
    main()
