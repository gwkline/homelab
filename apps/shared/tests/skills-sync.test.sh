#!/bin/sh
# Offline fixture test for the shared skills-sync library (homelab#81).
# Uses a real local fixture repository (file:// remote) to prove:
#   - pinned commit is fetched, verified, and recorded in status metadata
#   - only allowlisted skill paths are installed
#   - credentials never reach the clone's Git config or metadata
#   - install is idempotent (repeat run = byte-identical store)
#   - obsolete generated files are removed on the next sync
#   - private skills deterministically shadow public (P-Stack) skills
#   - secret-looking content is refused (store left untouched)
#   - the link farm owns only its own symlinks; stale links are removed
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$ROOT/apps/shared/skills-lib.sh"

die() { echo "FAIL: $1" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }
# Source (not execute) so the link-farm function can be exercised directly;
# $0 is this test, so the library's driver mode stays dormant.
. "$LIB"

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
REPO="$FIX/fixture-repo"
STORE="$FIX/store"
STATUS="$FIX/status.json"
CLONE="$FIX/workdir"
LINKS="$FIX/harness-skills"
PUBLIC="$FIX/public"

git init -q -b main "$REPO"
git -C "$REPO" config user.email fixture@example.com
git -C "$REPO" config user.name fixture
# Allow fetch-by-SHA so pinned-commit verification works over file:// too.
git -C "$REPO" config uploadpack.allowAnySHA1InWant true

mk_skill() {
  mkdir -p "$REPO/skills/$1"
  printf '%s\n' "$2" > "$REPO/skills/$1/SKILL.md"
}
mk_skill "software-development/poteto-mode" "private-poteto"
mk_skill "software-development/k3s-ops" "private-k3s"
# Built without a literal so the repo-wide secret-pattern scan stays quiet.
mk_skill "homelab/secret-skill" "token: ghp_$(printf 'ABCDEFGHIJ%.0s' 1 2 3 4)"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "fixture one"
SHA1="$(git -C "$REPO" rev-parse HEAD)"

export SKILLS_REPO_URL="file://$REPO"
export SKILLS_REF="$SHA1"
export SKILLS_ALLOWLIST="software-development/poteto-mode
software-development/k3s-ops"
export SKILLS_TARGET="$STORE"
export SKILLS_STATUS_FILE="$STATUS"
export SKILLS_WORKDIR="$CLONE"
export GH_TOKEN="fixture-dummy-token"

store_state() {
  for _f in $(find "$STORE" -type f | LC_ALL=C sort); do cksum "$_f"; done
}

echo '==> 1. pinned-SHA sync: verify + record + allowlist enforcement'
sh "$LIB"
grep -q '"ok":true' "$STATUS" || die "status not ok after first sync"
grep -q "\"ref\":\"$SHA1\"" "$STATUS" || die "status does not record requested ref"
grep -q "\"commit\":\"$SHA1\"" "$STATUS" || die "status does not record resolved commit"
[ -f "$STORE/software-development/poteto-mode/SKILL.md" ] || die "allowlisted skill not installed"
[ -f "$STORE/software-development/k3s-ops/SKILL.md" ] || die "allowlisted skill not installed"
[ ! -e "$STORE/homelab" ] || die "non-allowlisted skill path was installed"
[ -f "$STORE/.skills-sync-generated" ] || die "generated-store marker missing"
# Credentials must not be persisted in the clone's Git config or metadata.
if git -C "$CLONE" config --list 2>/dev/null | grep -F "fixture-dummy-token"; then
  die "token leaked into Git config"
fi
if grep -rqF "fixture-dummy-token" "$CLONE/.git" 2>/dev/null; then
  die "token leaked into the clone's git metadata"
fi

echo '==> 2. idempotent re-install'
BEFORE="$(store_state)"
sh "$LIB"
[ "$(store_state)" = "$BEFORE" ] || die "second sync changed the store (not idempotent)"
grep -q '"ok":true' "$STATUS" || die "status not ok after second sync"

echo '==> 3. obsolete generated files removed on next sync'
git -C "$REPO" rm -rq "skills/software-development/k3s-ops"
mk_skill "software-development/new-skill" "private-new"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "fixture two"
SHA2="$(git -C "$REPO" rev-parse HEAD)"
SKILLS_REF="$SHA2"
SKILLS_ALLOWLIST="software-development/poteto-mode
software-development/new-skill"
export SKILLS_REF SKILLS_ALLOWLIST
sh "$LIB"
grep -q "\"commit\":\"$SHA2\"" "$STATUS" || die "status does not record the new commit"
[ -f "$STORE/software-development/new-skill/SKILL.md" ] || die "newly allowlisted skill not installed"
[ ! -e "$STORE/software-development/k3s-ops" ] || die "obsolete generated skill was not removed"

echo '==> 4. deterministic precedence: private shadows public (P-Stack)'
mkdir -p "$PUBLIC/software-development/poteto-mode" "$PUBLIC/software-development/only-public"
printf '%s\n' "public-poteto" > "$PUBLIC/software-development/poteto-mode/SKILL.md"
printf '%s\n' "public-only" > "$PUBLIC/software-development/only-public/SKILL.md"
SKILLS_PUBLIC_DIR="$PUBLIC" sh "$LIB"
grep -q '"ok":true' "$STATUS" || die "status not ok after precedence sync"
grep -q 'private-poteto' "$STORE/software-development/poteto-mode/SKILL.md" \
  || die "private skill did not take precedence over public"
grep -q 'public-only' "$STORE/software-development/only-public/SKILL.md" \
  || die "public-only skill was not merged in"

echo '==> 5. link farm: owns only its links, removes stale ones'
rm -rf "$LINKS"
skills_link_generated "$STORE" "$LINKS"
[ "$(readlink "$LINKS/software-development/poteto-mode")" = "$STORE/software-development/poteto-mode" ] \
  || die "skill link does not point into the generated store"
[ -L "$LINKS/software-development/new-skill" ] || die "skill link not created"
# A stale link (into the store at a now-removed path) must go; a real user
# file at a link path must never be touched.
ln -sfn "$STORE/software-development/k3s-ops" "$LINKS/software-development/k3s-ops"
rm -f "$LINKS/software-development/poteto-mode"
printf 'user data\n' > "$LINKS/software-development/poteto-mode"
skills_link_generated "$STORE" "$LINKS"
[ ! -e "$LINKS/software-development/k3s-ops" ] || die "stale sync-owned link not removed"
[ "$(cat "$LINKS/software-development/poteto-mode")" = "user data" ] \
  || die "real user file was overwritten by the link farm"
[ -L "$LINKS/software-development/new-skill" ] || die "existing sync link was disturbed"

echo '==> 6. wrong pinned commit fails clearly and leaves the store intact'
if SKILLS_REF="0000000000000000000000000000000000000000" sh "$LIB" 2>/dev/null; then
  die "sync with unknown pinned SHA unexpectedly succeeded"
fi
grep -q '"ok":false' "$STATUS" || die "failed sync not recorded in status"
grep -q 'fetch' "$STATUS" || die "failure reason not recorded"
grep -q 'private-poteto' "$STORE/software-development/poteto-mode/SKILL.md" \
  || die "failed sync clobbered the previous good store"

echo '==> 7. pinned-commit verification catches a resolving mismatch'
SHIM="$FIX/bin"
mkdir -p "$SHIM"
cat > "$SHIM/git" <<'EOF'
#!/bin/sh
case "$*" in
  *rev-parse*HEAD*) echo "1111111111111111111111111111111111111111" ;;
  *) command git "$@" ;;
esac
EOF
chmod +x "$SHIM/git"
if SKILLS_REF="$SHA1" PATH="$SHIM:$PATH" skills_verify_pin 2>/dev/null; then
  die "pinned-commit mismatch was not detected"
fi
grep -q 'mismatch' "$STATUS" || die "mismatch reason not recorded"

echo '==> 8. secret-looking skill content is refused'
if SKILLS_ALLOWLIST="homelab/secret-skill" sh "$LIB" 2>/dev/null; then
  die "secret-looking skill was installed"
fi
grep -q '"ok":false' "$STATUS" || die "secret-scan refusal not recorded"
grep -q 'secret-looking' "$STATUS" || die "secret-scan reason not recorded"
grep -q 'private-poteto' "$STORE/software-development/poteto-mode/SKILL.md" \
  || die "secret-scan failure clobbered the previous good store"

echo '==> 9. named-ref (branch) sync resolves and records the commit'
SKILLS_REF="main" sh "$LIB"
grep -q '"ok":true' "$STATUS" || die "status not ok after branch sync"
grep -q "\"commit\":\"$SHA2\"" "$STATUS" || die "branch sync did not record resolved commit"

echo "PASS: skills-sync fixture tests (allowlist, pin verification, idempotency, obsolete removal, precedence, secret scan)"
