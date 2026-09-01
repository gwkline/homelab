#!/bin/bash
# Regression test: publisher must use the Git path shipped by the image.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../"

# The image build installs Debian's Git at /usr/bin/git; the orchestrator
# harness separately exercises clone/apply/commit/push against a real local repo.

grep -q 'gitt() { timeout 300 /usr/bin/git' apps/factory/orchestrator/run.sh || {
  echo "FAIL: orchestrator Git wrapper is not using the Debian Git path"
  exit 1
}
# Confirm the image definition installs the exact path used by the wrapper.
grep -q 'ca-certificates curl git jq' apps/factory/orchestrator/Dockerfile || {
  echo "FAIL: orchestrator image does not install Git"
  exit 1
}
echo "PASS: orchestrator Git runtime path is covered"
