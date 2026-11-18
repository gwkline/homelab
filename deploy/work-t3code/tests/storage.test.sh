#!/bin/sh
# Safety fixtures run with the standard deploy test discovery.
set -eu
cd "$(dirname "$0")"
python3 -m unittest -v test_migrate_storage.py
