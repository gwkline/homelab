#!/bin/bash
# The publisher must use the Git path the image actually ships.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../"
# apt installs git at /usr/bin/git on bookworm-slim.
grep -q 'gitt() { timeout 300 /usr/bin/git' apps/factory/orchestrator/run.sh || {
  echo "FAIL: orchestrator Git wrapper must use Debian's /usr/bin/git"
  exit 1
}
grep -q 'ln -s /usr/bin/git /usr/local/bin/git' apps/factory/orchestrator/Dockerfile || {
  echo "FAIL: orchestrator image compatibility link missing"
  exit 1
}
# Check the built image too, when it exists locally.
if command -v docker >/dev/null 2>&1 &&
  docker image inspect homelab-factory-orchestrator:test >/dev/null 2>&1; then
  docker run --rm --entrypoint /bin/sh homelab-factory-orchestrator:test \
    -c 'test -x /usr/local/bin/git && test -x /usr/bin/git && git --version >/dev/null' || {
    echo "FAIL: orchestrator image Git path is not executable"
    exit 1
  }
fi
echo "PASS: orchestrator Git runtime path is covered"
