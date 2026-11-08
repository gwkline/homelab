#!/bin/sh
set -eu
"${HOMELAB_PYTHON:-python3}" "$(dirname "$0")/post-renderer.test.py"
