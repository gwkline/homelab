#!/bin/sh
# Medic pod runner: sweep ci-red PRs and dispatch fixers (#239), then run the
# stalled-PR sweep (#242). Both are idempotent; order matters — dispatch first
# so attempt counters are fresh when the stalled sweep reads them.
set -u
/orch/sweep.sh
/orch/stalled-sweep.sh
