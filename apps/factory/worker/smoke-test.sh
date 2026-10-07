#!/bin/sh
# Runs inside the built image (`docker run --rm <image> smoke-test`) before
# it is signed: every advertised capability must answer.
set -eu

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

for c in git ssh node npm gh cargo codex claude opencode cursor-agent python3 dash; do
  command -v "$c" > /dev/null 2>&1 || fail "missing advertised binary: $c"
done

git --version > /dev/null || fail "git broken"
ssh -V 2>&1 | grep -q OpenSSH || fail "ssh client broken"
node --version > /dev/null || fail "node broken"
gh --version > /dev/null || fail "gh broken"
cargo --version > /dev/null || fail "cargo broken"
python3 --version > /dev/null || fail "python3 broken"

# Present on PATH is not enough: each CLI must actually run.
codex --version > /dev/null 2>&1 || fail "codex --version failed"
claude --version > /dev/null 2>&1 || fail "claude --version failed"
opencode --version > /dev/null 2>&1 || fail "opencode --version failed"
cursor-agent --version > /dev/null 2>&1 || fail "cursor-agent --version failed"

[ "$(id -u)" = "1000" ] || fail "image runs as uid $(id -u), expected 1000 (non-root)"

# Nothing that raises privilege: no container runtime, no setuid/setgid file.
for c in podman newuidmap newgidmap; do
  if command -v "$c" > /dev/null 2>&1; then fail "unexpected privileged tooling: $c"; fi
done
PRIVILEGED=$(find / -xdev -type f -perm /6000 2>/dev/null || true)
[ -z "${PRIVILEGED}" ] || fail "setuid/setgid files present: $(printf '%s' "${PRIVILEGED}" | tr '\n' ' ')"

# Pinned verification skills: content sha must match the manifest.
SKILLS_DIR="${FACTORY_SKILLS_DIR:-/usr/local/share/worker/skills}"
python3 - "${SKILLS_DIR}" << 'EOF'
import hashlib, json, sys, pathlib
d = pathlib.Path(sys.argv[1])
m = json.loads((d / "manifest.json").read_text())
assert m.get("pinned") is True, "skills are not pinned"
skill = d / m["name"] / "SKILL.md"
assert skill.is_file(), f"missing skill file: {skill}"
actual = hashlib.sha256(skill.read_bytes()).hexdigest()
assert actual == m["content_sha256"], f"pinned sha mismatch: {actual} != {m['content_sha256']}"
print(f"skills: {m['name']}@{m['version']} sha256 verified")
EOF

[ -s /usr/local/share/worker/brief.schema.json ] || fail "brief.schema.json missing"

echo "SMOKE OK: all advertised CLIs, non-root user, no setuid/setgid, pinned skills verified"
