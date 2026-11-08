#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "$script_dir" -p 'test_work_resource_guard.py' -v
