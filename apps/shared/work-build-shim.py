#!/usr/bin/env python3
"""Dispatch a generated work command shim while preserving every argument."""

import json
import os
from pathlib import Path
import sys


def main():
    tool = Path(sys.argv[0]).name
    try:
        mapping = os.environ.get("WORK_GUARD_COMMAND_MAP", "/tmp/work-resource-guard/commands.json")
        commands = json.loads(Path(mapping).read_text())
        executable = commands[tool]
    except (OSError, ValueError, KeyError):
        print("[work-resource-guard] real command mapping unavailable; refusing work", file=sys.stderr)
        return 75
    guard = str(Path(__file__).resolve().with_name("work_resource_guard.py"))
    os.execv(sys.executable, [sys.executable, guard, "build", "--tool", tool, "--", executable, *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
