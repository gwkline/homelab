#!/bin/sh
# Fixture test for apps/t3code/agent-state.sh:
#   - restore copies the PVC state in, skips excluded names, keeps image files
#   - save mirrors new files and deletions (a logout persists), keeps excluded
#     names container-local and drops copies older syncs left on the PVC
#   - session transcripts (claude projects/, codex sessions/) persist, since
#     T3 Code threads resume from them
#   - a live WAL-mode SQLite database with an open writer is saved through the
#     backup API: the copy passes integrity_check, holds every committed row,
#     and has no -wal/-shm beside it; a deleted database leaves the PVC too
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/../agent-state.sh"

die() {
  echo "FAIL: $1" >&2
  exit 1
}
for c in rsync python3; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "SKIP: $c not available"
    exit 0
  }
done

FIX="$(mktemp -d)"
WRITER=''
cleanup() {
  [ -z "$WRITER" ] || kill "$WRITER" 2>/dev/null || true
  rm -rf "$FIX"
}
trap cleanup EXIT
HOME_DIR="$FIX/home"
STATE="$FIX/state"
AGENT_STATE_LOCK="$FIX/lock"

# --- restore ---------------------------------------------------------------
mkdir -p "$STATE/.claude/projects/p" "$STATE/.claude/shell-snapshots" "$STATE/opencode/share/log" "$HOME_DIR/.claude"
echo creds >"$STATE/.claude/.credentials.json"
echo transcript >"$STATE/.claude/projects/p/s.jsonl"
echo snap >"$STATE/.claude/shell-snapshots/x.sh"
echo old-log >"$STATE/opencode/share/log/x.log"
echo image-default >"$HOME_DIR/.claude/settings.json"
agent_state_restore "$HOME_DIR" "$STATE" || die "restore failed"
[ -f "$HOME_DIR/.claude/.credentials.json" ] || die "restore missed credentials"
[ -f "$HOME_DIR/.claude/projects/p/s.jsonl" ] || die "restore missed a claude session transcript"
[ ! -e "$HOME_DIR/.claude/shell-snapshots" ] || die "restore copied an excluded dir"
[ ! -e "$HOME_DIR/.local/share/opencode/log" ] || die "restore copied opencode logs"
[ -f "$HOME_DIR/.claude/settings.json" ] || die "restore removed an image file"

# --- save: new files, deletions, excludes ----------------------------------
echo new >"$HOME_DIR/.claude/settings.local.json"
mkdir -p "$HOME_DIR/.claude/projects/q" "$HOME_DIR/.claude/statsig" "$HOME_DIR/.codex/log" "$HOME_DIR/.codex/sessions"
echo t >"$HOME_DIR/.claude/projects/q/s.jsonl"
echo s >"$HOME_DIR/.claude/statsig/cache"
echo l >"$HOME_DIR/.codex/log/codex.log"
echo r >"$HOME_DIR/.codex/sessions/rollout.jsonl"
echo auth >"$HOME_DIR/.codex/auth.json"
rm "$HOME_DIR/.claude/.credentials.json" # logout
agent_state_save "$HOME_DIR" "$STATE" || die "save failed"
[ -f "$STATE/.claude/settings.local.json" ] || die "save missed a new file"
[ -f "$STATE/.codex/auth.json" ] || die "save missed codex auth"
[ ! -e "$STATE/.claude/.credentials.json" ] || die "logout did not propagate"
[ -f "$STATE/.claude/projects/q/s.jsonl" ] || die "claude session transcript not saved"
[ -f "$STATE/.codex/sessions/rollout.jsonl" ] || die "codex session not saved"
[ ! -e "$STATE/.claude/statsig" ] || die "claude cache reached the PVC"
[ ! -e "$STATE/.claude/shell-snapshots" ] || die "excluded dir on the PVC was kept"
[ ! -e "$STATE/.codex/log" ] || die "codex log reached the PVC"
[ ! -e "$STATE/opencode/share/log" ] || die "stale opencode log copy was kept"
[ ! -e "$AGENT_STATE_LOCK" ] || die "lock left behind"

# --- SQLite under a live writer ----------------------------------------------
OC="$HOME_DIR/.local/share/opencode"
mkdir -p "$OC"
# Rows committed into the WAL and never checkpointed; the writer stays open.
python3 - "$OC/opencode.db" "$FIX/ready" <<'__PY__' &
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA wal_autocheckpoint=0")
db.execute("CREATE TABLE t (v TEXT)")
db.executemany("INSERT INTO t VALUES (?)", [("x" * 100,)] * 5000)
db.commit()
open(sys.argv[2], "w").close()
time.sleep(60)
__PY__
WRITER=$!
i=0
until [ -e "$FIX/ready" ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || die "sqlite writer never started"
  sleep 0.1
done
[ -s "$OC/opencode.db-wal" ] || die "fixture: rows should still be in the WAL"
# A torn copy from an older sync must not survive beside the new one.
mkdir -p "$STATE/opencode/share"
echo garbage >"$STATE/opencode/share/opencode.db-wal"
agent_state_save "$HOME_DIR" "$STATE" || die "save with a live database failed"
saved="$STATE/opencode/share/opencode.db"
[ -f "$saved" ] || die "database not saved"
[ ! -e "$saved-wal" ] && [ ! -e "$saved-shm" ] || die "stale -wal/-shm beside the saved database"
python3 - "$saved" <<'__PY__' || die "saved database is damaged or incomplete"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert db.execute("SELECT count(*) FROM t").fetchone()[0] == 5000
__PY__

# --- restore the database, then delete it ---------------------------------
kill "$WRITER"
wait "$WRITER" 2>/dev/null || true
WRITER=''
rm -f "$OC"/opencode.db*
agent_state_restore "$HOME_DIR" "$STATE" || die "restore with a database failed"
python3 - "$OC/opencode.db" <<'__PY__' || die "restored database is damaged or incomplete"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("SELECT count(*) FROM t").fetchone()[0] == 5000
__PY__
rm -f "$OC"/opencode.db*
agent_state_save "$HOME_DIR" "$STATE" || die "save after deleting the database failed"
[ ! -e "$saved" ] || die "deleted database stayed on the PVC"

echo "PASS: agent-state restore/save"
