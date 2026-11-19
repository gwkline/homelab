#!/bin/sh
# Prove the pg-backup pipeline end to end (deploy/postgres/README.md, Backups):
# run one pg-backup job now, restore the newest dump into a scratch database
# on the live cluster, compare table lists and row counts, then drop the
# scratch database. Needs the homelab kubeconfig:
#   KUBECONFIG=~/kubeconfig-homelab ./scripts/pg-backup-verify.sh
set -eu

NS="${PG_NS:-database}"
CLUSTER="${PG_CLUSTER:-pg-primary}"
POD="$CLUSTER-1"
SRC_DB="${PG_DATABASE:-knowledge}"
SCRATCH_DB="${RESTORE_DB:-knowledge_restore_test}"
SECRET="$CLUSTER-knowledge-owner"
BACKUP_JOB="pg-backup-verify-$(date -u +%Y%m%d%H%M%S)"
RESTORE_JOB="pg-restore-verify-$(date -u +%Y%m%d%H%M%S)"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

kc() { kubectl --request-timeout=30s "$@"; }

# SQL as the instance superuser over the pod socket: the only role that can
# create databases and extensions, neither of which the app owner may do.
super_sql() { # super_sql <db> <sql>
  kubectl exec -n "$NS" "$POD" -- psql -X -v ON_ERROR_STOP=1 -U postgres -d "$1" -At -c "$2"
}

wait_job() { # wait_job <job> <timeout-seconds>: fails printing the log
  i=0
  while [ "$i" -lt "$2" ]; do
    st="$(kc -n "$NS" get job "$1" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}')" || st=""
    [ "$st" = "True" ] && return 0
    st="$(kc -n "$NS" get job "$1" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}')" || st=""
    if [ "$st" = "True" ]; then
      kc -n "$NS" logs "job/$1" || true
      fail "job $1 failed"
    fi
    sleep 5
    i=$((i + 5))
  done
  kc -n "$NS" logs "job/$1" || true
  fail "timed out waiting for job $1"
}

tables() { # tables <db>: one schemaname.tablename per line
  super_sql "$1" "SELECT schemaname||'.'||tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1;"
}

# Per-table exact row counts in one statement, without dynamic SQL assembly:
# query_to_xml runs each count and xpath pulls the number back out.
row_counts() { # row_counts <db>: 'schemaname.tablename|count' per line
  super_sql "$1" "SELECT n.nspname||'.'||c.relname||'|'||
    (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY 1;"
}

drop_scratch() {
  super_sql postgres "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE);" >/dev/null
  kc -n "$NS" delete job "$RESTORE_JOB" --ignore-not-found >/dev/null
}

cleanup() { drop_scratch || true; }
trap cleanup EXIT INT TERM

kc -n "$NS" get cronjob pg-backup >/dev/null || fail "cronjob pg-backup not found in $NS"

# 1. One real backup run, now.
kc -n "$NS" create job --from=cronjob/pg-backup "$BACKUP_JOB" >/dev/null
wait_job "$BACKUP_JOB" 300
printf '%s\n' '--- backup job log ---'
kc -n "$NS" logs "job/$BACKUP_JOB"

# 2. Scratch database with the extensions pre-created as superuser; the dump
#    emits CREATE EXTENSION IF NOT EXISTS, which is then a no-op.
drop_scratch
super_sql postgres "CREATE DATABASE $SCRATCH_DB OWNER knowledge_owner;" >/dev/null
super_sql "$SCRATCH_DB" "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
super_sql "$SCRATCH_DB" "CREATE EXTENSION IF NOT EXISTS pg_textsearch;" >/dev/null

# 3. Restore into it with a one-shot Job cloned from the live CronJob's image,
#    mounts and credentials, so the restore path is the backup path.
image="$(kc -n "$NS" get cronjob pg-backup -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}')"
[ -n "$image" ] || fail "cannot read the pg-backup image"
cat <<EOF | kc apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $RESTORE_JOB
  namespace: $NS
  labels:
    app: pg-backup
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: pg-backup
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 26
        runAsGroup: 26
        fsGroup: 26
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: pg-restore
          image: $image
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 1Gi
          env:
            - name: PGHOST
              value: pg-primary-rw.database.svc
            - name: PGUSER
              valueFrom:
                secretKeyRef:
                  name: $SECRET
                  key: username
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: $SECRET
                  key: password
            - name: PGSSLMODE
              value: verify-full
            - name: PGSSLROOTCERT
              value: /certs/ca.crt
            - name: TARGET_DB
              value: $SCRATCH_DB
          volumeMounts:
            - name: backup
              mountPath: /backup
            - name: ca
              mountPath: /certs
              readOnly: true
            - name: tmp
              mountPath: /tmp
          command: ["/bin/sh", "-eu", "-c"]
          args:
            - |
              set -eu
              dump="\$(ls -1t /backup/knowledge-*.dump | head -n 1)"
              echo "restoring \$dump into \$TARGET_DB"
              # Probe the connect phase with retries: a fresh pod can out-run
              # kube-router's policy sync (#505). The restore itself runs once.
              n=0
              until psql --dbname="\$TARGET_DB" --command='SELECT 1' >/dev/null 2>&1; do
                n=\$((n + 1))
                [ "\$n" -ge 6 ] && { echo "connect refused after \$n attempts"; exit 1; }
                echo "connect attempt \$n failed; retrying in 20s"
                sleep 20
              done
              # --no-comments: the dump's COMMENT ON EXTENSION lines cannot run
              # as the app owner against the superuser-created extensions; the
              # restored data, schema and indexes do not need comments.
              pg_restore --exit-on-error --no-comments --dbname="\$TARGET_DB" "\$dump"
              echo "restore done"
      volumes:
        - name: backup
          persistentVolumeClaim:
            claimName: pg-backup
        - name: ca
          secret:
            secretName: pg-primary-ca
            defaultMode: 0400
        - name: tmp
          emptyDir: {}
EOF
wait_job "$RESTORE_JOB" 600
printf '%s\n' '--- restore job log ---'
kc -n "$NS" logs "job/$RESTORE_JOB"

# 4. The restored copy must match the source: same tables, same row counts.
has_smoke=false
tables "$SRC_DB" | grep -q '^smoke\.docs$' && has_smoke=true
src_t="$(mktemp)"; rst_t="$(mktemp)"
src_c="$(mktemp)"; rst_c="$(mktemp)"
tables "$SRC_DB" >"$src_t"
tables "$SCRATCH_DB" >"$rst_t"
row_counts "$SRC_DB" >"$src_c"
row_counts "$SCRATCH_DB" >"$rst_c"
printf '%s\n' '--- source row counts ---'
cat "$src_c"
if ! cmp -s "$src_t" "$rst_t"; then
  diff "$src_t" "$rst_t" || true
  fail "table lists differ between $SRC_DB and $SCRATCH_DB"
fi
if ! cmp -s "$src_c" "$rst_c"; then
  diff "$src_c" "$rst_c" || true
  fail "row counts differ between $SRC_DB and $SCRATCH_DB"
fi
rm -f "$src_t" "$rst_t" "$src_c" "$rst_c"

# 5. If the smoke fixture is in the dump (scripts/pg-smoke.sh seed), its
#    indexes were rebuilt by the restore: prove both access methods answer.
if [ "$has_smoke" = true ]; then
  top_vec="$(super_sql "$SCRATCH_DB" "SELECT id FROM smoke.docs ORDER BY embedding <=> '[0.9,0.1,0,0]' LIMIT 1;")"
  [ "$top_vec" = "1" ] || fail "restored HNSW index did not rank the postgres doc first (got: $top_vec)"
  top_bm="$(super_sql "$SCRATCH_DB" "SELECT id FROM smoke.docs ORDER BY content <@> to_bm25query('bm25 ranked search','smoke.smoke_docs_bm25_idx') LIMIT 1;")"
  [ "$top_bm" = "3" ] || fail "restored BM25 index did not rank the search doc first (got: $top_bm)"
  printf '%s\n' 'PASS: restored HNSW and BM25 indexes answer ranked queries'
fi

drop_scratch
trap - EXIT INT TERM
printf 'PASS: backup run + restore test into %s succeeded\n' "$SCRATCH_DB"
