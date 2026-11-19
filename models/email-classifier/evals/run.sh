#!/bin/sh
# Standing eval suite: one command regenerates evals/report.md and
# evals/scorecard.md from the fixed held-out time split (see
# src/common.py TEST_CUTOFF_MS). The repo's markdown formatter owns the
# final layout — CI enforces oxfmt on both files.
set -eu
cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ]; then
	PY=.venv/bin/python
elif [ -n "${PYTHON:-}" ]; then
	PY=$PYTHON
else
	PY=python3
fi
"$PY" src/eval_model.py
# Every candidate that has artifacts on disk joins the scorecard: v1
# snapshot, current v1.5 bundle, and the neural eval if one has been run.
"$PY" src/scorecard.py
if command -v npx >/dev/null 2>&1; then
	npx --no-install oxfmt evals/report.md evals/scorecard.md >/dev/null
	if [ -n "${EMAIL_CLASSIFIER_HOME:-}" ] && [ -d "${EMAIL_CLASSIFIER_HOME}/eval" ]; then
		cp evals/report.md "${EMAIL_CLASSIFIER_HOME}/eval/report.md"
		cp evals/scorecard.md "${EMAIL_CLASSIFIER_HOME}/eval/scorecard.md"
	fi
fi
