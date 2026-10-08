#!/bin/sh
# SQL smoke tests for the pg-primary CNPG cluster (deploy/postgres/README.md).
#
#   pg-smoke.sh seed     create extensions, rows, HNSW + BM25 indexes; run
#                        the ranked queries
#   pg-smoke.sh restart  delete the primary pod; wait for a healthy cluster
#   pg-smoke.sh verify   rows and indexes survived and still answer
set -eu

NS="${PG_NS:-database}"
CLUSTER="${PG_CLUSTER:-pg-primary}"
DB="${PG_DATABASE:-knowledge}"
DB_USER="${PG_DB_USER:-knowledge_owner}"
POD="$CLUSTER-1"
SECRET="$CLUSTER-$DB_USER"
EXPECTED_ROWS=4

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

usage() {
  printf 'usage: %s seed|restart|verify\n' "$0" >&2
  exit 2
}

# SQL runs as the application owner over TCP+SCRAM using the owner-role
# basic-auth Secret, which exercises the credential workflow end to end.
# psql_exec [psql options]: SQL on stdin. The password travels as the first
# stdin line, never in argv, where ps would show it on the laptop and in the
# pod.
psql_exec() {
  { printf '%s\n' "$PASSWORD"; cat; } |
    kubectl exec -i -n "$NS" "$POD" -- sh -c \
      'IFS= read -r PGPASSWORD && export PGPASSWORD && exec psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 "$@"' \
      psql -U "$DB_USER" -d "$DB" "$@"
}

# psql_query <sql>: one statement, unaligned tuples-only output.
psql_query() {
  printf '%s\n' "$1" | psql_exec -At
}

load_credentials() {
  PASSWORD="$(kubectl get secret -n "$NS" "$SECRET" \
    -o jsonpath='{.data.password}' | base64 -d)"
  [ -n "$PASSWORD" ] || fail "secret $SECRET has no password key"
}

check_cluster_healthy() {
  phase="$(kubectl get cluster -n "$NS" "$CLUSTER" -o jsonpath='{.status.phase}')"
  [ "$phase" = "Cluster in healthy state" ] \
    || fail "cluster $CLUSTER not healthy (phase: $phase)"
}

check_preload() {
  libs="$(psql_query 'SHOW shared_preload_libraries;')"
  case "$libs" in
    *pg_textsearch*) printf 'PASS: shared_preload_libraries = %s\n' "$libs" ;;
    *) fail "pg_textsearch missing from shared_preload_libraries (got: $libs)" ;;
  esac
}

check_extensions() {
  count="$(psql_query \
    "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','pg_textsearch');")"
  assert_eq "$count" "2" "both extensions installed (vector, pg_textsearch)"
}

check_indexes() {
  count="$(psql_query \
    "SELECT count(*) FROM pg_indexes
     WHERE schemaname = 'smoke'
       AND indexname IN ('smoke_docs_vec_idx','smoke_docs_bm25_idx');")"
  assert_eq "$count" "2" "both smoke indexes present (hnsw, bm25)"
}

check_vector_query() {
  top="$(psql_query \
    "SELECT id FROM smoke.docs
     ORDER BY embedding <=> '[0.9,0.1,0,0]' LIMIT 1;")"
  assert_eq "$top" "1" "vector similarity ranks the postgres doc first"
}

check_bm25_query() {
  top="$(psql_query \
    "SELECT id FROM smoke.docs
     ORDER BY content <@> to_bm25query('bm25 ranked search','smoke_docs_bm25_idx')
     LIMIT 1;")"
  assert_eq "$top" "3" "BM25 ranked query via to_bm25query hits the search doc"
}

cmd_seed() {
  check_cluster_healthy
  load_credentials
  psql_exec <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
DROP SCHEMA IF EXISTS smoke CASCADE;
CREATE SCHEMA smoke;
CREATE TABLE smoke.docs (
    id        bigserial PRIMARY KEY,
    content   text NOT NULL,
    embedding vector(4) NOT NULL
);
INSERT INTO smoke.docs (content, embedding) VALUES
    ('postgres storage and search', '[1,0,0,0]'),
    ('vector similarity with pgvector', '[0,1,0,0]'),
    ('bm25 ranked full text search', '[0,0,1,0]'),
    ('cooking recipe for sourdough bread', '[0,0,0,1]');
CREATE INDEX smoke_docs_vec_idx
    ON smoke.docs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX smoke_docs_bm25_idx
    ON smoke.docs USING bm25 (content) WITH (text_config='english');
SQL
  check_extensions
  check_preload
  check_indexes
  check_vector_query
  check_bm25_query
  printf 'seeded %s rows in %s/%s (schema smoke)\n' "$EXPECTED_ROWS" "$NS" "$DB"
}

cmd_restart() {
  check_cluster_healthy
  allowed="$(kubectl get pdb -n "$NS" "$CLUSTER-pdb" \
    -o jsonpath='{.status.disruptionsAllowed}')"
  assert_eq "$allowed" "1" "PDB allows one voluntary disruption of the healthy primary"
  # kubectl delete bypasses the eviction API, so delete even if the PDB
  # changed under us; the assertion above is the recorded PDB behavior check.
  kubectl delete pod -n "$NS" "$POD" --wait=false
  printf 'deleted %s; waiting for the replacement to become ready...\n' "$POD"
  kubectl wait -n "$NS" "pod/$POD" --for=condition=Ready --timeout=300s
  i=0
  while [ "$i" -lt 60 ]; do
    phase="$(kubectl get cluster -n "$NS" "$CLUSTER" -o jsonpath='{.status.phase}')"
    [ "$phase" = "Cluster in healthy state" ] && break
    i=$((i + 1))
    sleep 5
  done
  check_cluster_healthy
  printf 'PASS: pod restarted through CNPG graceful shutdown, cluster healthy\n'
}

cmd_verify() {
  check_cluster_healthy
  load_credentials
  rows="$(psql_query 'SELECT count(*) FROM smoke.docs;')"
  assert_eq "$rows" "$EXPECTED_ROWS" "test rows survived the restart"
  check_extensions
  check_preload
  check_indexes
  check_vector_query
  check_bm25_query
  printf 'ALL SMOKE CHECKS PASSED\n'
}

[ "$#" -eq 1 ] || usage
case "$1" in
  seed) cmd_seed ;;
  restart) cmd_restart ;;
  verify) cmd_verify ;;
  *) usage ;;
esac
