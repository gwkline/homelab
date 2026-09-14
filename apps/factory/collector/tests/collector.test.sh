#!/bin/sh
# Offline behavior tests for the issue collector (#78). The suite is
# TypeScript (tests/*.test.ts via node --test, faking the GitHub API with an
# in-memory server/client — no network, no cluster); this shim keeps the
# repo's historical fixture-test command working from any directory
# (docs/factory-fixture-e2e.md).
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
exec npm --prefix "${root}/apps/factory/collector" test
