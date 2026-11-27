#!/bin/sh
# Stand-in for systemd-inhibit(1) in containers without systemd.
#
# The T3 runtime spawns `systemd-inhibit` to hold a sleep-inhibit lock
# while long-running commands execute. The container image has no
# systemd, so the real binary is absent; the failed spawn previously
# took down the keep-awake watchdog and shut the whole workspace down
# (exit 75 loop).
#
# Behavior:
#   * systemd-inhibit options are skipped (both `--opt=value` and
#     `--opt value` forms, plus the `--` separator);
#   * if a command remains after the options, it runs and its exit
#     status is returned — but a 127 (command not found, e.g. an
#     option value misread as a command) falls back to holding the
#     lock instead of dying;
#   * with no command, the stub holds until signaled, standing in for
#     a held inhibit lock the runtime can stop later.
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ $# -gt 0 ]; then
  "$@"
  rc=$?
  [ "$rc" -ne 127 ] && exit "$rc"
fi
exec sleep 2147483647
