# Factory Run marker comment body (ADR-003 ledger): one comment per Run,
# created once and edited in place. Sourced by run.sh, which supplies NUM,
# RUN_TS, PROFILE, WORKFLOW_VERSION, WORKER_IMAGE and timestamp().
#
# FACTORY_TRIGGERED_BY (validated by the panel) records who requested the run;
# WORKER_MODEL attributes outcomes per model and is empty for non-model
# profiles.

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
  if [ -n "${WORKER_MODEL:-}" ]; then
    _fm_rows="${_fm_rows}| Model | ${WORKER_MODEL} |
"
  fi
  cat <<EOF
<!-- ${FACTORY_RUN_MARKER}${NUM}:${RUN_TS} -->
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