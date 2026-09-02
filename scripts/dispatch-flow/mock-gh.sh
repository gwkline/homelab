#!/bin/sh
# Mock gh CLI for the dispatch flow smoke (issue #30). The dispatch watcher's
# only GitHub call is `gh api repos/<owner>/<repo>/issues?labels=<label>...`;
# this stand-in serves the committed fixture (fixture-issues.json, a
# documented disposable test issue) instead of the real GitHub API, so the
# smoke never triggers real issue work. Everything after the listing —
# kubectl, RBAC, Job creation, execution — stays real.
set -eu

FIXTURE="${MOCK_ISSUES_FILE:-/smoke/issues.json}"

[ "${1:-}" = "api" ] || {
  echo "mock-gh: unsupported subcommand: $*" >&2
  exit 2
}
[ $# -ge 2 ] || {
  echo "mock-gh: missing api path" >&2
  exit 2
}
case "$2" in
  repos/*/issues\?labels=*)
    [ -r "$FIXTURE" ] || {
      echo "mock-gh: fixture not readable: $FIXTURE" >&2
      exit 2
    }
    cat "$FIXTURE"
    ;;
  *)
    echo "mock-gh: unsupported api path: $2" >&2
    exit 2
    ;;
esac
