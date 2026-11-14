#!/bin/sh
set -eu
node --test "$(dirname "$0")/render.test.mjs"
