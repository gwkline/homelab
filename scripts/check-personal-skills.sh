#!/bin/sh
# check-personal-skills.sh — CI contract check for the personal-skills design
# (ADR-003, homelab#69). Validates the local fixture against the canonical
# skill contract, then proves the harmless sample skill loads into three
# harness adapters (claude, hermes, codex) in throwaway sandboxes:
#   1. manifest <-> directory consistency (nothing unlisted, nothing missing)
#   2. secret-pattern scan over the fixture
#   3. sample skill installs into claude + hermes + codex with receipts
#   4. re-run with an unchanged pin is an idempotent no-op
#   5. default-deny: empty allowlist installs nothing; unknown names rejected
#   6. pre-existing user content is never overwritten
#   7. unreviewed files (fetched code) block installation
set -eu
cd "$(dirname "$0")/.."

FIXTURE="examples/personal-skills-fixture"
INSTALL="scripts/install-personal-skills.sh"
SAMPLE="tailnet-etiquette"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Same pattern set as scripts/verify.sh; bare prefix literals assembled from
# parts so this file never contains a scannable string itself.
_sp_gh="github_pat"
_sp_ts="tskey"
SECRET_PATTERN="(${_sp_gh}_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|${_sp_ts}-auth-)"

[ -f "${FIXTURE}/skills.yaml" ] || fail "fixture manifest missing"
[ -d "${FIXTURE}/skills" ] || fail "fixture skills dir missing"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT INT TERM
mlist="${work}/manifest.txt"

echo '==> manifest <-> directory consistency'
sh "${INSTALL}" manifest "${FIXTURE}" > "${mlist}"
[ -s "${mlist}" ] || fail "manifest lists no skills"
while read -r m_name m_allow m_files; do
  [ -n "${m_name}" ] || continue
  printf '%s\n' "${m_name}" | grep -Eq '^[a-z][a-z0-9-]{0,63}$' \
    || fail "invalid skill name '${m_name}'"
  if [ "${m_allow}" != "allow" ] && [ "${m_allow}" != "deny" ]; then
    fail "skill ${m_name}: allow must be true or false"
  fi
  [ -d "${FIXTURE}/skills/${m_name}" ] || fail "manifest entry ${m_name} has no skills/${m_name} dir"
  [ -f "${FIXTURE}/skills/${m_name}/SKILL.md" ] || fail "skill ${m_name}: missing SKILL.md"
  grep -Eq "^name:[[:space:]]*${m_name}[[:space:]]*$" "${FIXTURE}/skills/${m_name}/SKILL.md" \
    || fail "skill ${m_name}: SKILL.md frontmatter name mismatch"
  # shellcheck disable=SC2086  # deliberate word-split of reviewed file list
  for m_f in ${m_files:-}; do
    [ -f "${FIXTURE}/skills/${m_name}/${m_f}" ] \
      || fail "skill ${m_name}: reviewed file ${m_f} missing"
  done
done < "${mlist}"
for m_dir in "${FIXTURE}/skills"/*/; do
  m_d="$(basename "${m_dir}")"
  grep -q "^${m_d} " "${mlist}" \
    || fail "skills/${m_d} is not registered in the manifest (every skill must be reviewed)"
done
grep -q "^${SAMPLE} allow" "${mlist}" \
  || fail "sample skill ${SAMPLE} must be allow: true for the harness demo"

echo '==> secret-pattern scan over fixture'
if grep -rnIEq -- "${SECRET_PATTERN}" "${FIXTURE}" 2>/dev/null; then
  fail "secret-looking string in the fixture"
fi

echo '==> sample skill installs into claude + hermes + codex (sandbox)'
sb_home="${work}/home"
sb_hermes="${work}/hermes"
if ! HOME="${sb_home}" HERMES_HOME="${sb_hermes}" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${FIXTURE}" SKILLS_ALLOWLIST="${SAMPLE}" \
  SKILLS_ADAPTERS="claude hermes codex" \
  sh "${INSTALL}" > "${work}/install.log" 2>&1; then
  cat "${work}/install.log" >&2
  fail "sample skill install failed"
fi
[ -f "${sb_home}/.claude/skills/${SAMPLE}/SKILL.md" ] \
  || fail "claude harness did not load the sample skill"
[ -f "${sb_hermes}/skills/${SAMPLE}/SKILL.md" ] \
  || fail "hermes harness did not load the sample skill"
grep -q "agent-skills:${SAMPLE}:begin" "${sb_home}/.codex/AGENTS.md" \
  || fail "codex harness did not load the sample skill"
[ -f "${sb_home}/.agent-skills/receipts/claude/${SAMPLE}" ] \
  || fail "missing claude install receipt"
[ -f "${sb_home}/.agent-skills/receipts/hermes/${SAMPLE}" ] \
  || fail "missing hermes install receipt"
grep -q '"ok": true' "${sb_home}/.agent-skills/status.json" \
  || fail "install status is not ok"

echo '==> re-run with unchanged pin is an idempotent no-op'
before="$(find "${sb_home}/.claude/skills" "${sb_hermes}/skills" -type f | sort | cksum)"
m_before="$(grep -c "agent-skills:${SAMPLE}:begin" "${sb_home}/.codex/AGENTS.md" || true)"
if ! HOME="${sb_home}" HERMES_HOME="${sb_hermes}" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${FIXTURE}" SKILLS_ALLOWLIST="${SAMPLE}" \
  SKILLS_ADAPTERS="claude hermes codex" \
  sh "${INSTALL}" > "${work}/install2.log" 2>&1; then
  cat "${work}/install2.log" >&2
  fail "idempotent re-install failed"
fi
after="$(find "${sb_home}/.claude/skills" "${sb_hermes}/skills" -type f | sort | cksum)"
m_after="$(grep -c "agent-skills:${SAMPLE}:begin" "${sb_home}/.codex/AGENTS.md" || true)"
[ "${before}" = "${after}" ] || fail "re-install mutated installed files (not idempotent)"
[ "${m_before}" = "${m_after}" ] || fail "re-install duplicated the codex skill block"

echo '==> default-deny: empty allowlist installs nothing'
deny="${work}/deny"
if ! HOME="${deny}/home" HERMES_HOME="${deny}/hermes" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${FIXTURE}" \
  sh "${INSTALL}" > "${work}/deny.log" 2>&1; then
  cat "${work}/deny.log" >&2
  fail "empty allowlist should be a clean no-op"
fi
[ ! -e "${deny}/home/.claude/skills" ] \
  || fail "default-deny violated: something installed with an empty allowlist"

echo '==> unknown allowlist entry is rejected'
unknown="${work}/unknown"
if HOME="${unknown}/home" HERMES_HOME="${unknown}/hermes" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${FIXTURE}" SKILLS_ALLOWLIST="not-a-real-skill" \
  sh "${INSTALL}" > "${work}/unknown.log" 2>&1; then
  fail "unknown allowlist entry accepted (strict run should fail)"
fi
[ ! -e "${unknown}/home/.claude/skills" ] \
  || fail "unknown allowlist entry installed something"

echo '==> pre-existing user content is never overwritten'
user="${work}/user"
mkdir -p "${user}/home/.claude/skills/${SAMPLE}"
printf 'my own notes — do not touch\n' > "${user}/home/.claude/skills/${SAMPLE}/SKILL.md"
if ! HOME="${user}/home" HERMES_HOME="${user}/hermes" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${FIXTURE}" SKILLS_ALLOWLIST="${SAMPLE}" \
  SKILLS_ADAPTERS="claude" \
  sh "${INSTALL}" > "${work}/user.log" 2>&1; then
  cat "${work}/user.log" >&2
  fail "unowned target should be skipped, not failed hard"
fi
grep -q "my own notes" "${user}/home/.claude/skills/${SAMPLE}/SKILL.md" \
  || fail "installer overwrote user content"

echo '==> unreviewed files block installation'
rogue="${work}/rogue"
mkdir -p "${rogue}/src"
cp -a "${FIXTURE}/." "${rogue}/src/"
printf '#!/bin/sh\ntrue\n' > "${rogue}/src/skills/${SAMPLE}/helper.sh"
if HOME="${rogue}/home" HERMES_HOME="${rogue}/hermes" SKILLS_STRICT=1 \
  SKILLS_SOURCE="${rogue}/src" SKILLS_ALLOWLIST="${SAMPLE}" \
  SKILLS_ADAPTERS="claude" \
  sh "${INSTALL}" > "${work}/rogue.log" 2>&1; then
  fail "unreviewed file did not block installation"
fi
[ ! -e "${rogue}/home/.claude/skills/${SAMPLE}/helper.sh" ] \
  || fail "fetched code was installed without review"

echo 'ALL PERSONAL-SKILLS CHECKS PASSED'
