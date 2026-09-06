#!/bin/sh
# shellcheck shell=sh
#
# Standalone end-to-end fixture for the pg-textsearch CNPG extension image
# (issue #48): builds the image, mounts it exactly the way a CNPG ImageVolume
# does, and proves against the exact digest-pinned operand that the library
# loads, CREATE EXTENSION works, a BM25 index can be built, and a ranked
# query answers. Runs in CI (build job, pg-textsearch matrix leg) on every
# PR and main push, before the image is signed and published.
#
# CNPG mounting conventions (cloudnative-pg imagevolume_extensions docs):
# the extension image content is mounted read-only at /extensions/<name>,
# extension_control_path gets /extensions/<name>/share (control + SQL live
# under share/extension), dynamic_library_path gets /extensions/<name>/lib,
# and shared_preload_libraries carries pg_textsearch because the extension
# requires preload. The fixture reproduces that wiring with plain docker —
# no operator, no cluster.
#
# ABI proof: the fixture boots the operand image pinned in the Dockerfile
# (ARG BASE) — the same image the extension was compiled against — so a
# mismatch (PG major, distro, arch) fails here rather than in a cluster.
# The image is built for the CI runner architecture (amd64), which is what
# the homelab targets (deploy/postgres/base/cluster.yaml), so arm64 is not
# published.
#
# Upstream `make installcheck` needs a full in-tree pg_regress setup and is
# superseded here by this fixture (the "where feasible" part of #48): it
# exercises the same extension surface end to end.
set -eu

cd "$(dirname "$0")/../.."

DOCKERFILE=images/pg-textsearch/Dockerfile
IMAGE=pg-textsearch-fixture:local
EXT_MOUNT=/extensions/pg-textsearch
CN=
FS_CN=
TMP=

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    printf 'PASS: %s\n' "$3"
  else
    printf 'FAIL: %s (got "%s", want "%s")\n' "$3" "$1" "$2" >&2
    exit 1
  fi
}

cleanup() {
  if [ -n "$CN" ]; then docker rm -f "$CN" >/dev/null 2>&1 || true; fi
  if [ -n "$FS_CN" ]; then docker rm -f "$FS_CN" >/dev/null 2>&1 || true; fi
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT INT TERM

# The pins in the Dockerfile are the single source of truth: the fixture must
# test exactly what CI builds and what cluster.yaml deploys.
BASE_IMAGE="$(sed -n 's/^ARG BASE=//p' "$DOCKERFILE" | head -n 1)"
PG_MAJOR="$(sed -n 's/^ARG PG_MAJOR=//p' "$DOCKERFILE" | head -n 1)"
EXT_VERSION="$(sed -n 's/^ARG EXT_VERSION=//p' "$DOCKERFILE" | head -n 1)"
[ -n "$BASE_IMAGE" ] || fail "cannot read ARG BASE from $DOCKERFILE"
[ -n "$PG_MAJOR" ] || fail "cannot read ARG PG_MAJOR from $DOCKERFILE"
[ -n "$EXT_VERSION" ] || fail "cannot read ARG EXT_VERSION from $DOCKERFILE"

printf '==> building %s (base: %s)\n' "$IMAGE" "$BASE_IMAGE"
docker buildx build --load -t "$IMAGE" -f "$DOCKERFILE" .

# Extract the image tree and assert the CNPG extension layout
# (/lib + /share/extension) that the ImageVolume mount will serve.
printf '==> asserting the CNPG extension image layout\n'
TMP="$(mktemp -d)"
EXT_ROOT="$TMP/extroot"
mkdir -p "$EXT_ROOT"
# The mount root keeps host ownership inside the container; the postgres user
# must be able to traverse it (files inside are 644/755 from the image).
chmod 755 "$EXT_ROOT"
FS_CN=pg-textsearch-fixture-fs
docker create --name "$FS_CN" "$IMAGE" >/dev/null
docker export "$FS_CN" | tar -xf - -C "$EXT_ROOT"
docker rm "$FS_CN" >/dev/null
FS_CN=
test -f "$EXT_ROOT/lib/pg_textsearch.so" \
  || fail "image layout: missing /lib/pg_textsearch.so"
test -f "$EXT_ROOT/share/extension/pg_textsearch.control" \
  || fail "image layout: missing /share/extension/pg_textsearch.control"
printf 'PASS: image ships the CNPG layout (/lib, /share/extension)\n'

# The postgres uid must come from the operand image itself (ABI partner).
PG_UID="$(docker run --rm --entrypoint /bin/sh "$BASE_IMAGE" -c 'id -u postgres')"
[ -n "$PG_UID" ] || fail "operand image has no postgres user"

# Boot the operand with the extension mounted the way CNPG mounts an
# ImageVolume and with the GUCs CNPG sets automatically. PG_MAJOR is passed
# through so the bootstrap can find the Debian-layout binaries.
BOOTSTRAP=$(cat <<'EOF'
set -eu
PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
"${PG_BIN}/initdb" --no-locale -E UTF8 -A trust -U postgres -D /tmp/fixture
exec "${PG_BIN}/postgres" -D /tmp/fixture -k /tmp \
  -c listen_addresses=127.0.0.1 \
  -c shared_preload_libraries=pg_textsearch \
  -c extension_control_path=/extensions/pg-textsearch/share \
  -c dynamic_library_path=/extensions/pg-textsearch/lib
EOF
)
printf '==> booting the operand with the extension mounted as CNPG would\n'
CN=pg-textsearch-fixture
docker run -d --name "$CN" \
  --user "$PG_UID" \
  --entrypoint /bin/sh \
  -e PG_MAJOR="$PG_MAJOR" \
  -v "$EXT_ROOT:$EXT_MOUNT:ro" \
  "$BASE_IMAGE" -c "$BOOTSTRAP" >/dev/null

PSQL="/usr/lib/postgresql/${PG_MAJOR}/bin/psql"
psql_exec() {
  docker exec "$CN" "$PSQL" -X -At -h /tmp -U postgres -d postgres "$@"
}

i=0
until docker exec "$CN" "$PSQL" -X -Atq -h /tmp -U postgres -d postgres \
    -c 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    docker logs "$CN" >&2 || true
    fail 'postgres did not become ready within 120s'
  fi
  sleep 1
done
printf 'PASS: operand postgres up with pg_textsearch preloaded\n'

# The fixture: load the library (already proven by the server coming up),
# install the extension, build a BM25 index.
docker exec -i "$CN" "$PSQL" -X -v ON_ERROR_STOP=1 -h /tmp -U postgres \
  -d postgres <<'SQL'
CREATE EXTENSION pg_textsearch;
CREATE TABLE fixture_docs (
    id      bigserial PRIMARY KEY,
    content text NOT NULL
);
INSERT INTO fixture_docs (content) VALUES
    ('postgres storage and search'),
    ('vector similarity with pgvector'),
    ('bm25 ranked full text search'),
    ('cooking recipe for sourdough bread');
CREATE INDEX fixture_docs_bm25_idx
    ON fixture_docs USING bm25 (content) WITH (text_config = 'english');
SQL
printf 'PASS: CREATE EXTENSION pg_textsearch + BM25 index built\n'

preload="$(psql_exec -c 'SHOW shared_preload_libraries;')"
case "$preload" in
  *pg_textsearch*) printf 'PASS: shared_preload_libraries = %s\n' "$preload" ;;
  *) fail "pg_textsearch missing from shared_preload_libraries (got: $preload)" ;;
esac

version="$(psql_exec -c \
  "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch';")"
assert_eq "$version" "$EXT_VERSION" \
  "extension version matches the pinned release (v$EXT_VERSION)"

top="$(psql_exec -c "SELECT id FROM fixture_docs
     ORDER BY content <@> to_bm25query('bm25 ranked search', 'fixture_docs_bm25_idx')
     LIMIT 1;")"
assert_eq "$top" "3" "BM25 ranked query ranks the bm25 doc first"

top="$(psql_exec -c "SELECT id FROM fixture_docs
     ORDER BY content <@> to_bm25query('postgres storage', 'fixture_docs_bm25_idx')
     LIMIT 1;")"
assert_eq "$top" "1" "BM25 ranked query ranks the postgres doc first"

unmatched="$(psql_exec -c "SELECT count(*) FROM fixture_docs
     WHERE content <@> to_bm25query('zzzqqqxyzzy', 'fixture_docs_bm25_idx') < 0;")"
assert_eq "$unmatched" "0" "no-hit query returns zero scored rows"

printf 'ALL FIXTURE CHECKS PASSED\n'
