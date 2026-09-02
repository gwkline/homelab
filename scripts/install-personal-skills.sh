#!/bin/sh
# install-personal-skills.sh — inject the personal-skills repository into
# agent harnesses (ADR-003, homelab#69).
#
# Flow: resolve a pinned skills source, apply the manifest allowlist and
# review gates, install each allowlisted skill into the configured harness
# adapters, and record exactly what was installed (receipts + status.json).
#
# Degradation contract (mirrors deploy/hermes/base/skills-sync.yaml): under
# pod init containers this NEVER fails the workload — errors land in
# status.json and the exit code is 0. Set SKILLS_STRICT=1 (CI, local runs)
# to make errors fatal.
#
# Environment:
#   SKILLS_SOURCE        git URL of the private skills repo, or a local
#                        directory (fixture mode). Default:
#                        https://github.com/gwkline/.agent-skills
#   SKILLS_REF           pinned tag or full commit SHA; required for git
#                        sources. Floating refs (main/master) are rejected
#                        unless SKILLS_ALLOW_FLOATING_REF=1.
#   SKILLS_ALLOWLIST     space-separated skill names this consumer may load.
#                        Default-deny: empty installs nothing.
#   SKILLS_ADAPTERS      harness adapters to inject into (default "claude
#                        hermes").
#   GITHUB_TOKEN_FILE    read-only PAT mount (default /secrets/token); needs
#                        only Contents:read on the skills repo.
#   SKILLS_STATE_DIR     receipts + status.json (default $HOME/.agent-skills).
#   SKILLS_DIR_<ADAPTER> per-adapter target directory override.
#   SKILLS_STRICT        1 = exit non-zero on errors.
#
# Usage:
#   install-personal-skills.sh                 install (default action)
#   install-personal-skills.sh manifest <dir>  print parsed manifest entries
#                                              as "<name> <allow|deny> [files]"

set -eu

DEFAULT_SOURCE="https://github.com/gwkline/.agent-skills"

# Secret-pattern scan, same pattern set as scripts/verify.sh. The two bare
# prefix literals are assembled from parts so this file never contains a
# scannable string itself (verify.sh's scan covers every other file).
_sp_gh="github_pat"
_sp_ts="tskey"
SECRET_PATTERN="(${_sp_gh}_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|${_sp_ts}-auth-)"

_source="${SKILLS_SOURCE:-${DEFAULT_SOURCE}}"
_ref="${SKILLS_REF:-}"
_mode="pending"
_commit="unknown"
_workdir=""
_cleanups=""

STATE_DIR="${SKILLS_STATE_DIR:-${HOME}/.agent-skills}"
STATUS_FILE="${STATE_DIR}/status.json"
RECEIPTS="${STATE_DIR}/receipts"

_errors=0
_last_error=""
_errors_json=""
_installed_json=""
_skipped_json=""
_rejected_json=""

note() { printf '[skills] %s\n' "$1"; }
warn() { printf '[skills] WARNING: %s\n' "$1" >&2; }

jesc() { printf '%s' "$1" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

add_error() {
  _errors=$((_errors + 1))
  _last_error="$1"
  _errors_json="${_errors_json:+${_errors_json}, }\"$(jesc "$1")\""
  warn "$1"
}

add_installed() { _installed_json="${_installed_json:+${_installed_json}, }\"$(jesc "$1")\""; }
add_skipped() { _skipped_json="${_skipped_json:+${_skipped_json}, }\"$(jesc "$1")\""; }
add_rejected() { _rejected_json="${_rejected_json:+${_rejected_json}, }\"$(jesc "$1")\""; }

cleanup() {
  if [ -n "${_cleanups}" ]; then
    # shellcheck disable=SC2086  # deliberate word-split of deferred paths
    rm -rf ${_cleanups}
  fi
}
trap cleanup EXIT INT TERM

defer_rm() { _cleanups="${_cleanups} $1"; }

sum_of() { cksum "$1" | awk '{print $1 ":" $2}'; }

# Emit "<name> <allow|deny> [files...]" per skills.yaml entry. Inline file
# lists must be [] (empty) or a block list; inline non-empty lists are not
# supported.
parse_manifest() {
  awk '
    { sub(/\r$/, ""); sub(/#.*/, ""); sub(/[[:space:]]+$/, "") }
    /^skills:/ { insec = 1; next }
    insec && /^[A-Za-z_-]+:/ { exit }
    !insec { next }
    /^[[:space:]]*-[[:space:]]*name:/ {
      if (name != "") print name " " allow " " files
      sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "")
      name = $0; allow = "deny"; files = ""; pending = 0
      next
    }
    /^[[:space:]]+allow:/ {
      sub(/^[[:space:]]+allow:[[:space:]]*/, "")
      allow = ($0 == "true") ? "allow" : "deny"
      next
    }
    /^[[:space:]]+files:/ {
      sub(/^[[:space:]]+files:[[:space:]]*/, "")
      if ($0 == "") { pending = 1; files = "" }
      else { pending = 0; files = ($0 == "[]") ? "" : $0 }
      next
    }
    pending && /^[[:space:]]+-[[:space:]]/ {
      sub(/^[[:space:]]+-[[:space:]]*/, "")
      files = files (files == "" ? "" : " ") $0
      next
    }
    END { if (name != "") print name " " allow " " files }
  ' "${1}/skills.yaml"
}

manifest_lookup() {
  ml_found=0
  ml_allow=""
  ml_files=""
  while read -r ml_name ml_allow ml_files; do
    if [ "${ml_name}" = "$2" ]; then
      ml_found=1
      return 0
    fi
  done < "$1"
  return 0
}

valid_name() {
  printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9-]{0,63}$'
}

# Review gates for one skill: SKILL.md present, secret scan clean, and every
# file reviewed (SKILL.md + manifest files:). Sets gt_ok=0/1.
gt_ok=1
gate_skill() {
  gt_ok=1
  gt_dir="$1"
  gt_name="$2"
  if [ ! -f "${gt_dir}/SKILL.md" ]; then
    add_error "skill ${gt_name}: missing SKILL.md"
    gt_ok=0
    return 0
  fi
  if grep -rnIEq -- "${SECRET_PATTERN}" "${gt_dir}" 2>/dev/null; then
    add_error "skill ${gt_name}: secret-pattern scan hit — skills never carry credential values"
    gt_ok=0
    return 0
  fi
  gt_allowed=" SKILL.md ${ml_files} "
  # shellcheck disable=SC2045  # deliberate word-split of find output
  for gt_f in $(cd "${gt_dir}" && find . -type f | sed 's|^\./||' | sort); do
    case "${gt_allowed}" in
      *" ${gt_f} "*) ;;
      *)
        add_error "skill ${gt_name}: unreviewed file '${gt_f}' — list it under files: in skills.yaml after human review"
        gt_ok=0
        ;;
    esac
  done
  return 0
}

adapter_dir() {
  case "$1" in
    claude) printf '%s\n' "${SKILLS_DIR_CLAUDE:-${HOME}/.claude/skills}" ;;
    opencode) printf '%s\n' "${SKILLS_DIR_OPENCODE:-${HOME}/.config/opencode/skill}" ;;
    hermes) printf '%s\n' "${SKILLS_DIR_HERMES:-${HERMES_HOME:-/data/hermes}/skills}" ;;
    cursor) printf '%s\n' "${SKILLS_DIR_CURSOR:-${HOME}/.cursor/rules}" ;;
    codex) printf '%s\n' "${SKILLS_DIR_CODEX:-${HOME}/.codex}" ;;
    *) return 1 ;;
  esac
}

receipt_path() {
  printf '%s/%s/%s\n' "${RECEIPTS}" "$1" "$2"
}

receipt_match() {
  [ -f "$1" ] || return 1
  grep -q "^commit=$2$" "$1" && grep -q "^sum=$3$" "$1"
}

write_receipt() {
  rp_rcp="$(receipt_path "$1" "$2")"
  if ! mkdir -p "$(dirname "${rp_rcp}")"; then
    add_error "cannot create receipt dir for ${1}/${2}"
    return 0
  fi
  {
    printf 'adapter=%s\n' "$1"
    printf 'name=%s\n' "$2"
    printf 'ref=%s\n' "$3"
    printf 'commit=%s\n' "$4"
    printf 'sum=%s\n' "$5"
    printf 'time=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "${rp_rcp}"
}

# Copy-adapter install (claude / opencode / hermes): skill dir -> target dir.
install_dir_adapter() {
  da_adapter="$1"
  da_name="$2"
  da_src="$3"
  da_sum="$4"
  da_ref="$5"
  da_commit="$6"
  da_tgt="$(adapter_dir "${da_adapter}")/${da_name}"
  da_rcp="$(receipt_path "${da_adapter}" "${da_name}")"
  if [ -e "${da_tgt}" ] && [ ! -f "${da_rcp}" ]; then
    warn "adapter ${da_adapter}: ${da_tgt} exists but was not installed by us — leaving user state untouched"
    add_skipped "${da_adapter}/${da_name} (unowned target)"
    return 0
  fi
  if [ -f "${da_rcp}" ] && receipt_match "${da_rcp}" "${da_commit}" "${da_sum}"; then
    return 0
  fi
  if ! rm -rf "${da_tgt}" || ! mkdir -p "${da_tgt}"; then
    add_error "adapter ${da_adapter}: cannot prepare target ${da_tgt}"
    return 0
  fi
  if ! cp -a "${da_src}/." "${da_tgt}/"; then
    add_error "adapter ${da_adapter}: copy into ${da_tgt} failed"
    return 0
  fi
  write_receipt "${da_adapter}" "${da_name}" "${da_ref}" "${da_commit}" "${da_sum}"
  add_installed "${da_adapter}/${da_name}"
  return 0
}

strip_frontmatter() {
  awk '
    NR == 1 && $0 ~ /^---[[:space:]]*$/ { infm = 1; next }
    infm == 1 && $0 ~ /^---[[:space:]]*$/ { infm = 0; next }
    infm == 1 { next }
    { print }
  ' "$1"
}

fm_field() {
  awk -v f="$2" '
    NR == 1 && $0 ~ /^---[[:space:]]*$/ { infm = 1; next }
    infm == 1 && $0 ~ /^---[[:space:]]*$/ { exit }
    infm == 1 && index($0, f ":") == 1 {
      sub(/^[^:]*:[[:space:]]*/, "")
      print
      exit
    }
  ' "$1"
}

# Cursor adapter: render the skill as an always-on rule in a file whose name
# the installer owns (agent-skills-<name>.mdc).
install_cursor_adapter() {
  cu_name="$1"
  cu_md="$2"
  cu_sum="$3"
  cu_ref="$4"
  cu_commit="$5"
  cu_dir="$(adapter_dir cursor)"
  cu_tgt="${cu_dir}/agent-skills-${cu_name}.mdc"
  cu_rcp="$(receipt_path cursor "${cu_name}")"
  if [ -e "${cu_tgt}" ] && [ ! -f "${cu_rcp}" ]; then
    warn "adapter cursor: ${cu_tgt} exists but was not installed by us — leaving user state untouched"
    add_skipped "cursor/${cu_name} (unowned target)"
    return 0
  fi
  if [ -f "${cu_rcp}" ] && receipt_match "${cu_rcp}" "${cu_commit}" "${cu_sum}"; then
    return 0
  fi
  cu_desc="$(fm_field "${cu_md}" description)"
  if ! mkdir -p "${cu_dir}"; then
    add_error "adapter cursor: cannot create ${cu_dir}"
    return 0
  fi
  if ! {
    printf -- '---\n'
    printf 'description: %s\n' "${cu_desc}"
    printf 'alwaysApply: true\n'
    printf -- '---\n\n'
    strip_frontmatter "${cu_md}"
  } > "${cu_tgt}"; then
    add_error "adapter cursor: cannot write ${cu_tgt}"
    return 0
  fi
  write_receipt cursor "${cu_name}" "${cu_ref}" "${cu_commit}" "${cu_sum}"
  add_installed "cursor/${cu_name}"
  return 0
}

# Codex adapter: additive marker-guarded block in $CODEX_DIR/AGENTS.md.
install_codex_adapter() {
  cx_name="$1"
  cx_md="$2"
  cx_sum="$3"
  cx_ref="$4"
  cx_commit="$5"
  cx_dir="$(adapter_dir codex)"
  cx_tgt="${cx_dir}/AGENTS.md"
  cx_rcp="$(receipt_path codex "${cx_name}")"
  cx_marker="agent-skills:${cx_name}:begin"
  cx_present=0
  if [ -f "${cx_tgt}" ] && grep -q "${cx_marker}" "${cx_tgt}"; then
    cx_present=1
  fi
  if [ "${cx_present}" = "1" ] && [ -f "${cx_rcp}" ] \
    && receipt_match "${cx_rcp}" "${cx_commit}" "${cx_sum}"; then
    return 0
  fi
  if ! mkdir -p "${cx_dir}"; then
    add_error "adapter codex: cannot create ${cx_dir}"
    return 0
  fi
  if [ "${cx_present}" = "1" ]; then
    # refresh: drop only our own block, leave all other content untouched
    cx_tmp="$(mktemp)"
    defer_rm "${cx_tmp}"
    awk -v b="${cx_marker}" -v e="agent-skills:${cx_name}:end" '
      $0 ~ b { skip = 1; next }
      skip == 1 && $0 ~ e { skip = 0; next }
      skip == 1 { next }
      { print }
    ' "${cx_tgt}" > "${cx_tmp}" || {
      add_error "adapter codex: cannot rewrite block in ${cx_tgt}"
      return 0
    }
    if ! mv "${cx_tmp}" "${cx_tgt}"; then
      add_error "adapter codex: cannot replace ${cx_tgt}"
      return 0
    fi
  fi
  if ! {
    printf '\n<!-- %s -->\n' "${cx_marker}"
    printf '## Skill: %s\n\n' "${cx_name}"
    strip_frontmatter "${cx_md}"
    printf '\n<!-- agent-skills:%s:end -->\n' "${cx_name}"
  } >> "${cx_tgt}"; then
    add_error "adapter codex: cannot append block to ${cx_tgt}"
    return 0
  fi
  write_receipt codex "${cx_name}" "${cx_ref}" "${cx_commit}" "${cx_sum}"
  add_installed "codex/${cx_name}"
  return 0
}

write_status() {
  if ! mkdir -p "${STATE_DIR}"; then
    warn "cannot create ${STATE_DIR} — status not written"
    return 0
  fi
  if [ "${_errors}" -gt 0 ]; then st_ok="false"; else st_ok="true"; fi
  {
    printf '{\n'
    printf '  "time": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "ok": %s,\n' "${st_ok}"
    printf '  "source": "%s",\n' "$(jesc "${_source}")"
    printf '  "mode": "%s",\n' "${_mode}"
    printf '  "ref": "%s",\n' "$(jesc "${_ref:-local}")"
    printf '  "commit": "%s",\n' "${_commit}"
    printf '  "adapters": "%s",\n' "$(jesc "${_adapters}")"
    printf '  "installed": [%s],\n' "${_installed_json:-}"
    printf '  "skipped": [%s],\n' "${_skipped_json:-}"
    printf '  "rejected": [%s],\n' "${_rejected_json:-}"
    printf '  "errors": [%s]\n' "${_errors_json:-}"
    printf '}\n'
  } > "${STATUS_FILE}"
  note "status written to ${STATUS_FILE}"
}

finish() {
  write_status
  if [ "${_errors}" -gt 0 ]; then
    if [ "${SKILLS_STRICT:-0}" = "1" ]; then
      printf '[skills] STRICT: failing with %s error(s)\n' "${_errors}" >&2
      exit 1
    fi
    warn "degraded: ${_errors} error(s); continuing under the pod degradation contract (last: ${_last_error})"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Subcommand: print parsed manifest entries (used by check-personal-skills.sh)
# ---------------------------------------------------------------------------
if [ "${1:-}" = "manifest" ]; then
  if [ -z "${2:-}" ] || [ ! -f "${2}/skills.yaml" ]; then
    printf 'usage: %s manifest <skills-repo-dir>\n' "$0" >&2
    exit 1
  fi
  parse_manifest "$2"
  exit 0
fi
if [ -n "${1:-}" ]; then
  printf 'usage: %s [manifest <dir>]\n' "$0" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Main: resolve the pinned source
# ---------------------------------------------------------------------------
_workdir="$(mktemp -d)"
defer_rm "${_workdir}"

if [ -d "${_source}" ]; then
  _mode="local"
  _srcdir="${_source}"
  if [ -d "${_source}/.git" ]; then
    _commit="$(git -C "${_source}" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi
  _ref="local"
else
  _mode="git"
  if [ -z "${_ref}" ]; then
    add_error "SKILLS_REF is required for git sources — pin a tag or full commit SHA for reproducibility"
    finish
  fi
  case "${_ref}" in
    main | master)
      if [ "${SKILLS_ALLOW_FLOATING_REF:-0}" != "1" ]; then
        add_error "SKILLS_REF=${_ref} is a floating ref — pin a tag or full SHA (override with SKILLS_ALLOW_FLOATING_REF=1)"
        finish
      fi
      ;;
  esac
  _token=""
  if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
    _token="$(cat "${GITHUB_TOKEN_FILE}")"
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    _token="${GITHUB_TOKEN}"
  fi
  if [ -n "${_token}" ]; then
    # Clone through a mktemp askpass helper (workspace-lib pattern): the token
    # never touches URLs, argv, env, or .git/config.
    _askpass="$(mktemp)"
    defer_rm "${_askpass}"
    # shellcheck disable=SC2016  # literal $1 is part of the generated helper
    {
      echo '#!/bin/sh'
      echo 'case "$1" in'
      echo '  Username*) echo "x-access-token" ;;'
      echo '  Password*) cat <<"__TOK__"'
      printf '%s\n' "${_token}"
      echo '__TOK__'
      echo '  ;;'
      echo 'esac'
    } > "${_askpass}"
    chmod 700 "${_askpass}"
    export GIT_ASKPASS="${_askpass}"
    unset _token
  else
    warn "no token via GITHUB_TOKEN_FILE/GITHUB_TOKEN — private repos will fail to clone"
  fi
  export GIT_TERMINAL_PROMPT=0
  _srcdir="${_workdir}/repo"
  if ! mkdir -p "${_srcdir}"; then
    add_error "cannot create clone dir ${_srcdir}"
    finish
  fi
  if [ "${#_ref}" -eq 40 ] && printf '%s' "${_ref}" | grep -Eq '^[0-9a-f]+$'; then
    if ! git -C "${_srcdir}" init -q \
      || ! git -C "${_srcdir}" remote add origin "${_source}" \
      || ! git -C "${_srcdir}" fetch -q --depth 1 origin "${_ref}"; then
      add_error "git fetch ${_ref} failed (SHA reachable? token authorized for the skills repo?)"
      finish
    fi
    if ! git -C "${_srcdir}" checkout -q FETCH_HEAD; then
      add_error "git checkout FETCH_HEAD failed"
      finish
    fi
  else
    if ! git clone -q --depth 1 --branch "${_ref}" "${_source}" "${_srcdir}"; then
      add_error "git clone ${_source}@${_ref} failed (private? check the token secret)"
      finish
    fi
  fi
  _commit="$(git -C "${_srcdir}" rev-parse HEAD)"
fi

_mfile="${_workdir}/manifest.txt"
if [ ! -f "${_srcdir}/skills.yaml" ]; then
  add_error "skills.yaml missing at the source root"
  finish
fi
parse_manifest "${_srcdir}" > "${_mfile}"

# Validate the manifest itself (names, review flags, dirs present)
while read -r _mn _ma; do
  [ -n "${_mn}" ] || continue
  if ! valid_name "${_mn}"; then
    add_error "manifest: invalid skill name '${_mn}' (lowercase alnum/dash, <=64 chars)"
  fi
  case "${_ma}" in
    allow | deny) ;;
    *)
      add_error "manifest: skill ${_mn} has allow=${_ma:-<missing>} (must be true or false)"
      ;;
  esac
  if [ ! -d "${_srcdir}/skills/${_mn}" ]; then
    add_error "manifest: skill ${_mn} has no skills/${_mn} directory"
  fi
done < "${_mfile}"

_adapters="${SKILLS_ADAPTERS:-claude hermes}"
# shellcheck disable=SC2086  # deliberate word-split of adapter list
for _a in ${_adapters}; do
  if ! adapter_dir "${_a}" >/dev/null; then
    add_error "unknown adapter '${_a}' (supported: claude opencode hermes cursor codex)"
    finish
  fi
done

_allowlist="${SKILLS_ALLOWLIST:-}"
if [ -z "${_allowlist}" ]; then
  note "SKILLS_ALLOWLIST is empty — default-deny, nothing will be installed"
fi

# shellcheck disable=SC2086  # deliberate word-split of allowlist names
for _name in ${_allowlist}; do
  if ! valid_name "${_name}"; then
    add_error "allowlist entry '${_name}' is not a valid skill name"
    continue
  fi
  manifest_lookup "${_mfile}" "${_name}"
  if [ "${ml_found}" -ne 1 ]; then
    add_error "allowlist entry '${_name}' is not in the source manifest"
    continue
  fi
  if [ "${ml_allow}" != "allow" ]; then
    note "skill ${_name}: not reviewed (allow: false) — skipped"
    add_rejected "${_name} (not reviewed)"
    continue
  fi
  _skill_dir="${_srcdir}/skills/${_name}"
  _skill_md="${_skill_dir}/SKILL.md"
  gate_skill "${_skill_dir}" "${_name}"
  if [ "${gt_ok}" -ne 1 ]; then
    add_rejected "${_name} (failed review gates)"
    continue
  fi
  _sum="$(sum_of "${_skill_md}")"
  # shellcheck disable=SC2086  # deliberate word-split of adapter list
  for _a in ${_adapters}; do
    case "${_a}" in
      claude | opencode | hermes)
        install_dir_adapter "${_a}" "${_name}" "${_skill_dir}" "${_skill_md}" \
          "${_ref}" "${_commit}" || true
        ;;
      cursor)
        install_cursor_adapter "${_name}" "${_skill_md}" "${_sum}" "${_ref}" "${_commit}" || true
        ;;
      codex)
        install_codex_adapter "${_name}" "${_skill_md}" "${_sum}" "${_ref}" "${_commit}" || true
        ;;
    esac
  done
done

finish
