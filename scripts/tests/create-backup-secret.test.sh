#!/bin/sh
# Regression test for the backup-secret input path (homelab#10).
#
# Runs scripts/create-backup-secret.sh against a stub kubectl (no cluster,
# no network) and proves:
#   - interactive input is captured byte-exactly: leading/trailing spaces,
#     backslashes (including a trailing one), '=' and '$' survive untouched,
#     with no leading or trailing newline added to the value
#   - the visual newline after each hidden read goes to stderr only — stdout
#     carries no prompt or blank-line residue
#   - prompts reach the terminal when stdin is a terminal (pty run)
#   - environment-variable input stays non-interactive (stdin untouched)
#   - an empty value fails before any Secret is applied
# Only dummy literals are used; values are compared, never printed by the
# test (the pty may echo pre-fed bytes into its temp typescript, which is
# deleted on exit and never printed).
# Usage: sh scripts/tests/create-backup-secret.test.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$SCRIPT_DIR/../create-backup-secret.sh"

die() { echo "FAIL: $1" >&2; exit 1; }
[ -f "$TARGET" ] || die "missing $TARGET"
command -v bash >/dev/null 2>&1 || die "bash not available"
command -v cmp >/dev/null 2>&1 || die "cmp not available"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Dummy credentials shaped to break under IFS stripping, backslash mangling,
# or command-substitution wrapping (the #10 corruption shape); safe to commit.
# The literals must keep '$' and '\' verbatim, hence the disables:
# shellcheck disable=SC2016 disable=SC1003
DUMMY_ID='  b2 keyID 42  '
# shellcheck disable=SC2016 disable=SC1003
DUMMY_KEY='app\key=eq$x$(p)\ends\with\slash\'
# shellcheck disable=SC2016 disable=SC1003
DUMMY_PASS='restic p@ss\word=eq$dollar'

# Stub kubectl: `get` succeeds (namespace exists), `create` echoes its
# --from-literal args as the "manifest", `apply` snapshots stdin and marks
# that a Secret was applied.
cat > "$WORK/kubectl" <<'STUB'
#!/bin/sh
case "$1" in
  get)
    exit 0
    ;;
  create)
    for arg in "$@"
    do
      case "$arg" in --from-literal=*) printf '%s\n' "$arg" ;; esac
    done
    exit 0
    ;;
  apply)
    cat > "$KCTL_RECORD"
    : > "$KCTL_APPLIED"
    exit 0
    ;;
esac
echo "stub kubectl: unexpected invocation: $*" >&2
exit 1
STUB
chmod +x "$WORK/kubectl"
PATH="$WORK:$PATH"
export PATH KCTL_RECORD="$WORK/record" KCTL_APPLIED="$WORK/applied"

# Extract one --from-literal=<key>=<value> line and compare the value
# byte-exactly against the dummy.
check_literal() {
  _key=$1
  _expected=$2
  _actual=
  while IFS= read -r _line
  do
    case "$_line" in
      "--from-literal=$_key="*) _actual="${_line#"--from-literal=$_key="}" ;;
    esac
  done < "$WORK/record"
  [ -n "$_actual" ] || die "$_key missing from the recorded manifest"
  [ "$_actual" = "$_expected" ] \
    || die "$_key not byte-exact (values intentionally not printed)"
}

check_all_literals() {
  check_literal B2_ACCOUNT_ID "$DUMMY_ID"
  check_literal B2_ACCOUNT_KEY "$DUMMY_KEY"
  check_literal RESTIC_PASSWORD "$DUMMY_PASS"
}

expect_prompts() {
  grep -q 'B2 keyID:' "$1" || die 'B2 keyID prompt missing from terminal output'
  grep -q 'B2 applicationKey:' "$1" || die 'B2 applicationKey prompt missing from terminal output'
  grep -q 'restic repo password' "$1" || die 'restic password prompt missing from terminal output'
}

# --- pipe run: stream discipline + byte-exact capture -----------------------
printf '%s\n' "$DUMMY_ID" "$DUMMY_KEY" "$DUMMY_PASS" > "$WORK/input"
if ! bash "$TARGET" bucket-one homelab \
    < "$WORK/input" > "$WORK/stdout" 2> "$WORK/stderr"
then
  die 'pipe run failed'
fi
# stdout must be exactly the success line: no prompts, no visual newlines.
printf "%s\n" "==> backup-target secret applied in namespace 'agents'" \
  > "$WORK/expected_stdout"
cmp -s "$WORK/stdout" "$WORK/expected_stdout" \
  || die 'stdout carries prompt/newline residue (must be stderr only)'
# stderr must be exactly the three visual newlines after the hidden reads.
printf '\n\n\n' > "$WORK/expected_stderr"
cmp -s "$WORK/stderr" "$WORK/expected_stderr" \
  || die 'stderr must carry exactly the visual newlines, nothing else'
[ -f "$WORK/applied" ] || die 'Secret was not applied'
check_all_literals

# --- pty run: prompts reach the terminal when stdin is a terminal -----------
if command -v script >/dev/null 2>&1; then
  rm -f "$WORK/applied"
  if ! script -qec "bash '$TARGET' bucket-two homelab" /dev/null \
      < "$WORK/input" > "$WORK/typescript" 2>&1
  then
    die 'pty run failed'
  fi
  expect_prompts "$WORK/typescript"
  [ -f "$WORK/applied" ] || die 'pty run did not apply the Secret'
  check_all_literals
else
  echo 'SKIP: pty run (script(1) not available)'
fi

# --- environment-variable path: non-interactive, stdin untouched ------------
rm -f "$WORK/applied"
if ! B2_ACCOUNT_ID="$DUMMY_ID" B2_ACCOUNT_KEY="$DUMMY_KEY" \
    RESTIC_PASSWORD="$DUMMY_PASS" \
    bash "$TARGET" bucket-three homelab \
    < /dev/null > "$WORK/stdout" 2> "$WORK/stderr"
then
  die 'env-var run failed — env input must stay non-interactive'
fi
if grep -q 'B2 keyID:' "$WORK/stderr" || grep -q 'restic repo password' "$WORK/stderr"
then
  die 'env-var run prompted — env input must stay non-interactive'
fi
[ -f "$WORK/applied" ] || die 'env-var run did not apply the Secret'
check_all_literals

# --- empty value: fails before any Secret is applied ------------------------
rm -f "$WORK/applied"
printf '\n%s\n%s\n' "$DUMMY_KEY" "$DUMMY_PASS" > "$WORK/empty_input"
if bash "$TARGET" bucket-four homelab \
    < "$WORK/empty_input" > "$WORK/stdout" 2> "$WORK/stderr"
then
  die 'empty value must make the script fail'
fi
[ ! -e "$WORK/applied" ] || die 'empty value reached kubectl apply'
grep -q 'empty value' "$WORK/stderr" || die 'empty-value failure not reported'

echo 'PASS: create-backup-secret input path is byte-exact (#10)'
