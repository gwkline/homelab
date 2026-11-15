#!/bin/sh
# Exercise the checked-in node retention policy in the normal shared suite.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
python3 -m unittest discover -s "$ROOT/bootstrap/tests" -p test_storage_policy.py
