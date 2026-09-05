# Factory Run marker comment body (ADR-002 ledger): one comment per Run,
# created once and edited in place. Sourced by run.sh, which supplies the
# run context (NUM, RUN_TS, PROFILE, WORKFLOW_VERSION, WORKER_IMAGE) and
# timestamp().
#
# Audit identity (#84): when the run was requested through the Executor MCP
# gateway, the panel injects FACTORY_TRIGGERED_BY (label-safe charset — the
# panel validates it) and the marker records the caller so the audit event on
# the issue preserves who drove the run, not just what ran.

factory_marker_body() {  # <status> <extra-markdown> [<updated-ts>]
  _fm_rows=""
  if [ -n "${3:-}" ]; then
    _fm_rows="| Updated | ${3} |
"
  fi
  if [ -n "${FACTORY_TRIGGERED_BY:-}" ]; then
    _fm_rows="${_fm_rows}| Requested by | ${FACTORY_TRIGGERED_BY} |
"
  fi
  cat <<EOF
<!-- factory:run:${NUM}:${RUN_TS} -->
## 🏭 Factory Run

| | |
|---|---|
| Status | ${1} |
| Started | ${RUN_TS} |
${_fm_rows}| Profile | ${PROFILE} |
| Workflow | ${PROFILE}@${WORKFLOW_VERSION} (${WORKER_IMAGE}) |

${2:-_Worker dispatched._}
EOF
}