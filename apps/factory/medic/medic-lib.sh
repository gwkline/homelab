#!/bin/sh
# Factory medic shared helpers (#239) — the ONLY write paths the medic has.
# Sourced by run-medic.sh and the fixture tests. gh/jq/git are called by name
# so tests can shim them via PATH.
#
# Guardrails enforced here (issue #239):
#   - the ONLY git write path is medic_publish_patch: a fast-forward push of
#     exactly the PR's existing factory branch. There is no --force, no
#     branch creation, no main push anywhere on this file — and the agent
#     that produced the patch holds no push credential at all (the worker
#     entrypoint drops GH_TOKEN before the agent starts).

# Refuse anything that is not a factory issue branch. Covers main/master by
# construction; the explicit cases below keep the refusal readable in logs.
# $1 = branch name; returns 97 on refusal.
medic_guard_branch() {
  _mgb_branch="${1:-}"
  case "${_mgb_branch}" in
    main|master|*/main|*/master)
      echo "[medic] REFUSED: '${_mgb_branch}' is a protected branch — medic pushes PR branches only" >&2
      return 97
      ;;
  esac
  case "${_mgb_branch}" in
    factory/issue-*/*) ;;
    *)
      echo "[medic] REFUSED: '${_mgb_branch}' is not a factory/issue-* branch — medic never creates branches" >&2
      return 97
      ;;
  esac
}

# Apply the patch to the branch and push it. The ONLY publish path.
#   $1 = repo dir (fresh clone; git identity configured by the caller)
#   $2 = PR branch (must pass medic_guard_branch)
#   $3 = patch file (git apply format)
#   $4 = expected origin head SHA the run was pinned to (fast-forward guard)
# Returns 0 on success; 9x with a logged reason otherwise. On success the
# caller reads the new head from the repo dir itself.
medic_publish_patch() {
  _mpp_dir="${1:?repo dir}"
  _mpp_branch="${2:?branch}"
  _mpp_patch="${3:?patch file}"
  _mpp_expected="${4:-}"

  medic_guard_branch "${_mpp_branch}" || return $?

  [ -f "${_mpp_patch}" ] || {
    echo "[medic] REFUSED: patch artifact missing (${_mpp_patch})" >&2
    return 96
  }

  # Fast-forward guarantee: origin must still be exactly the head the run
  # was pinned to. If it moved (a human or another run pushed meanwhile),
  # abort — medic never overwrites anyone's commit. This check plus the
  # refspec below make a force-push structurally impossible on this path.
  _mpp_remote=$(git -C "${_mpp_dir}" ls-remote origin "refs/heads/${_mpp_branch}" | cut -f1)
  if [ -z "${_mpp_remote}" ]; then
    echo "[medic] REFUSED: ${_mpp_branch} does not exist on origin — medic never creates branches" >&2
    return 95
  fi
  if [ -n "${_mpp_expected}" ] && [ "${_mpp_remote}" != "${_mpp_expected}" ]; then
    echo "[medic] REFUSED: origin/${_mpp_branch} moved since detection — not overwriting it" >&2
    return 94
  fi

  git -C "${_mpp_dir}" checkout -q "${_mpp_branch}" || return 93
  if ! git -C "${_mpp_dir}" apply --whitespace=nowarn "${_mpp_patch}" 2>/tmp/medic-apply-err; then
    echo "[medic] patch failed to apply to ${_mpp_branch}: $(head -3 /tmp/medic-apply-err)" >&2
    return 92
  fi
  git -C "${_mpp_dir}" add -A
  git -C "${_mpp_dir}" commit -qm "factory(medic): repair ci-red branch

Produced by factory medic (profile: medic). Fixes the failing checks on
this PR branch only; never touches main, never force-pushes." || {
    echo "[medic] nothing to commit after applying patch" >&2
    return 91
  }
  # Plain push, explicit refspec naming ONLY the PR branch. A non-fast-forward
  # is rejected by git itself (no force flag exists in this script).
  git -C "${_mpp_dir}" push -q origin "HEAD:refs/heads/${_mpp_branch}" || {
    echo "[medic] push of ${_mpp_branch} rejected by remote (non-fast-forward?)" >&2
    return 90
  }
}

# --- attempt ledger (GitHub-as-ledger: PR comments carry the markers) -------

# Marker for one failed medic attempt against a PR head SHA. The count of
# these comments IS the retry budget; a pushed fix changes the head SHA and
# the budget resets naturally.
medic_failed_marker() { # $1 = head sha
  printf '<!-- factory:medic:%s:failed -->' "${1:?sha}"
}

# Count failed attempts recorded for a PR head SHA.
#   $1 = repo, $2 = PR number, $3 = head sha
medic_count_failures() {
  gh api --paginate --slurp "repos/${1:?repo}/issues/${2:?pr}/comments" 2>/dev/null |
    jq -r --arg m "$(medic_failed_marker "${3:?sha}")" \
      '[.[][] | select(.body | contains($m))] | length'
}

# Record one failed attempt on the PR.
#   $1 = repo, $2 = PR number, $3 = head sha, $4 = reason markdown
medic_record_failure() {
  gh api -X POST "repos/${1:?repo}/issues/${2:?pr}/comments" \
    -f body="$(medic_failed_marker "${3:?sha}")
## 🩺 Factory Medic — repair attempt failed

${4}

_Automated factory-medic run; comment auto-managed._" >/dev/null
}

# Escalation: park the linked issue for a human. Retries stop because the
# failure count for this head SHA already exceeds the budget and every later
# sweep short-circuits on the count (and skips re-commenting via the label).
#   $1 = repo, $2 = issue number, $3 = PR number, $4 = head sha, $5 = attempts
medic_mark_stuck() {
  gh issue edit "${2:?issue}" -R "${1:?repo}" --add-label "factory/stuck" >/dev/null
  gh issue comment "${2:?issue}" -R "${1:?repo}" \
    --body="🩺🚨 Factory medic gave up: ${5:?n} consecutive failed repair attempts on PR #${3:?pr} at head \`${4:?sha}\` — labeled \`factory/stuck\`. A human takes it from here." >/dev/null
}
