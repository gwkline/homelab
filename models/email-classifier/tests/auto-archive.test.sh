#!/bin/sh
# Guard-logic tests for the briefing auto-archive step (synthetic data only).
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "$script_dir" -p 'test_auto_archive*.py' -v
