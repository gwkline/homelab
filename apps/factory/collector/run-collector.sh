#!/bin/sh
# Factory collector entrypoint (#78). The durable collector itself is
# TypeScript (run-collector.ts) — this shim only execs node, keeping the
# historical entrypoint name stable for the image. Untrusted issue content
# never crosses a shell boundary: the collector speaks JSON REST directly.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node --experimental-strip-types "${script_dir}/run-collector.ts" "$@"
