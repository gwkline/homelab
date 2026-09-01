#!/bin/bash
# Regression test: publisher must use the Git path shipped by the image.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../"
grep -q 'gitt() { timeout 300 /usr/local/bin/git' apps/factory/orchestrator/run.sh || {
  echo "FAIL: expected orchestrator Git wrapper was changed unexpectedly"
  exit 1
}
grep -q 'ln -s /usr/bin/git /usr/local/bin/git' apps/factory/orchestrator/Dockerfile || {
  echo "FAIL: orchestrator image compatibility link missing"
  exit 1
}
# Confirm the published container has the path used by the wrapper.
docker run --rm --entrypoint /bin/sh homelab-factory-orchestrator:test \
  -c 'test -x /usr/local/bin/git && git --version >/dev/null' || {
  echo "FAIL: orchestrator image Git path is not executable"
  exit 1
}
echo "PASS: orchestrator Git runtime path is covered"
