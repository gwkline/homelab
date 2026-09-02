#!/bin/bash
# Regression test: publisher must use the Git path shipped by the image.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../"
# #122: the wrapper must resolve /usr/bin/git (the apt package location on
# bookworm-slim). Hardcoding /usr/local/bin/git made every publish tick die
# with "timeout: failed to run command '/usr/local/bin/git'".
grep -q 'gitt() { timeout 300 /usr/bin/git' apps/factory/orchestrator/run.sh || {
  echo "FAIL: orchestrator Git wrapper must use Debian's /usr/bin/git"
  exit 1
}
grep -q 'ln -s /usr/bin/git /usr/local/bin/git' apps/factory/orchestrator/Dockerfile || {
  echo "FAIL: orchestrator image compatibility link missing"
  exit 1
}
# Confirm the published container has both paths working. Skipped when the
# image is not built locally (container builds are the CI/push gate, and this
# test must stay runnable offline alongside the other factory shell tests).
if command -v docker >/dev/null 2>&1 &&
  docker image inspect homelab-factory-orchestrator:test >/dev/null 2>&1; then
  docker run --rm --entrypoint /bin/sh homelab-factory-orchestrator:test \
    -c 'test -x /usr/local/bin/git && test -x /usr/bin/git && git --version >/dev/null' || {
    echo "FAIL: orchestrator image Git path is not executable"
    exit 1
  }
fi
echo "PASS: orchestrator Git runtime path is covered"
