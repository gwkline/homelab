#!/bin/sh
# Agent CLI state (logins, config, the OpenCode database) on the data PVC.
# The CLIs keep it under $HOME in the container; agent_state_restore copies
# the PVC copy in at start, agent_state_save mirrors it back. Saves propagate
# deletions (a logout stays logged out), copy each file atomically, and copy
# SQLite databases through SQLite's backup API, never as raw files, so a save
# taken mid-write is never torn.
#
# Sourced by init-workspace; needs rsync and python3.

# One line per directory: <path under $HOME> <path under the state dir>
# [names excluded at its top level]. Logs, caches and repo clones stay
# container-local. Claude's projects/ and Codex's sessions/ are kept: they are
# the transcripts T3 Code threads resume from, and every deploy restarts the
# pod.
AGENT_STATE_DIRS='
.claude .claude shell-snapshots statsig todos logs debug cache
.codex .codex log cache
.config/opencode .config/opencode node_modules
.local/share/opencode opencode/share log repos snapshot bin
.config/cursor .config/cursor
.cursor cursor projects
'

# SQLite files are handled by _agent_state_sqlite, never by rsync.
_AGENT_STATE_SQLITE='*.db *.db-wal *.db-shm *.db-journal *.sqlite *.sqlite-wal *.sqlite-shm *.sqlite-journal'

# _agent_state_copy <from> <to> <delete: 1|0> [excluded...]
_agent_state_copy() {
  _from=$1 _to=$2 _delete=$3
  shift 3
  [ -d "$_from" ] || return 0
  mkdir -p "$_to"
  set -f
  _args=''
  for _x in "$@"; do _args="$_args --exclude=/$_x"; done
  for _x in $_AGENT_STATE_SQLITE; do _args="$_args --exclude=$_x"; done
  if [ "$_delete" = 1 ]; then _args="$_args --delete"; fi
  # shellcheck disable=SC2086 # _args is a word list built above
  rsync -a $_args "$_from/" "$_to/" || {
    set +f
    return 1
  }
  set +f
  if [ "$_delete" = 1 ]; then
    # Excluded names are protected from --delete; drop copies older syncs left.
    for _x in "$@"; do rm -rf "${_to:?}/$_x"; done
  fi
  _agent_state_sqlite "$_from" "$_to" "$_delete" "$@"
}

# _agent_state_sqlite <from> <to> <delete: 1|0> [excluded...]: copy every
# database under <from> to <to> with the backup API (written to a temporary
# name, then renamed), drop stale -wal/-shm/-journal files next to the copy,
# and with delete=1 remove databases that no longer exist in <from>.
_agent_state_sqlite() {
  python3 - "$@" <<'__PY__'
import os, shutil, sqlite3, sys

src, dst, delete, excluded = sys.argv[1], sys.argv[2], sys.argv[3] == "1", set(sys.argv[4:])
SUFFIXES = (".db", ".sqlite")
SIDECARS = ("-wal", "-shm", "-journal")

def remove(path):
    for p in [path] + [path + s for s in SIDECARS]:
        if os.path.exists(p):
            os.remove(p)

def backup(s, tmp):
    a = sqlite3.connect(s, timeout=10)
    try:
        b = sqlite3.connect(tmp)
        try:
            a.backup(b)
        finally:
            b.close()
    finally:
        a.close()

def databases(root):
    found = set()
    for here, dirs, files in os.walk(root):
        if here == root:
            dirs[:] = [d for d in dirs if d not in excluded]
        for name in files:
            if name.endswith(SUFFIXES) and not (here == root and name in excluded):
                found.add(os.path.relpath(os.path.join(here, name), root))
    return found

failed = False
wanted = databases(src)
for rel in sorted(wanted):
    s, d = os.path.join(src, rel), os.path.join(dst, rel)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    tmp = "%s.tmp-%d" % (d, os.getpid())
    try:
        try:
            backup(s, tmp)
        except sqlite3.DatabaseError as e:
            if "not a database" not in str(e):
                raise
            # Named like a database but isn't one: an atomic plain copy.
            remove(tmp)
            shutil.copy2(s, tmp)
        for side in SIDECARS:
            if os.path.exists(d + side):
                os.remove(d + side)
        os.replace(tmp, d)
    except (OSError, sqlite3.Error) as e:
        failed = True
        print("[agent-state] cannot copy %s: %s" % (s, e), file=sys.stderr)
    remove(tmp)
if delete:
    for rel in databases(dst) - wanted:
        remove(os.path.join(dst, rel))
sys.exit(1 if failed else 0)
__PY__
}

# agent_state_restore <home> <state-dir>: PVC copy into the container. Files
# the image ships but the PVC lacks are left alone.
agent_state_restore() {
  _rc=0
  while read -r _home_rel _state_rel _excl; do
    [ -n "$_home_rel" ] || continue
    # shellcheck disable=SC2086 # _excl is a word list
    _agent_state_copy "$2/$_state_rel" "$1/$_home_rel" 0 $_excl || _rc=1
  done <<EOF
$AGENT_STATE_DIRS
EOF
  return "$_rc"
}

# agent_state_save <home> <state-dir>: mirror the container's state onto the
# PVC. Serialized with a lock, because the periodic save and the shutdown
# save can overlap.
agent_state_save() {
  _lock="${AGENT_STATE_LOCK:-/tmp/agent-state.lock}"
  _tries=0
  until mkdir "$_lock" 2>/dev/null; do
    _tries=$((_tries + 1))
    [ "$_tries" -lt 100 ] || return 1
    sleep 0.1
  done
  _rc=0
  while read -r _home_rel _state_rel _excl; do
    [ -n "$_home_rel" ] || continue
    # shellcheck disable=SC2086 # _excl is a word list
    _agent_state_copy "$1/$_home_rel" "$2/$_state_rel" 1 $_excl || _rc=1
  done <<EOF
$AGENT_STATE_DIRS
EOF
  rmdir "$_lock"
  return "$_rc"
}
