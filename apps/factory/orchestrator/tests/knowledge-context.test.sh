#!/bin/sh
# Tests for knowledge-context.sh (#86): cited context assembly for run briefs.
# Runs the real script against a stub retrieval service (local HTTP server
# speaking the apps/knowledge-retrieval /v1/search contract) and proves:
#   1. ok path: queries derived (title/body/paths), dedupe across queries,
#      deterministic ranking, citations carry full provenance
#   2. budget knobs: min_score filter, whole-chunk char budget, source cap
#   3. fail-open: connection refused / HTTP 401 / timeout / unset URL each
#      produce a valid record with an explicit status and exit 0
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
KC="${REPO_ROOT}/apps/factory/orchestrator/knowledge-context.sh"
SHELLCHECK="${HOME}/bin-sc/shellcheck"

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

# --- stub /v1/search server ----------------------------------------------------
# Canned results are selected by substring of the query (mirrors how derived
# queries differ: title/body/paths). When STUB_SLEEP is set the server stalls
# before answering (timeout test); when STUB_AUTH_FAIL=1 it always 401s.
cat > "${FIX}/stub.py" << 'PYEOF'
import json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

RESPONSES = json.load(open(os.environ["STUB_RESPONSES"], encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if os.environ.get("STUB_AUTH_FAIL") == "1":
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"code":"unauthorized","message":"bad token","runId":null}}')
            return
        length = int(self.headers.get("Content-Length") or 0)
        query = json.loads(self.rfile.read(length) or b"{}").get("query", "")
        if os.environ.get("STUB_SLEEP"):
            time.sleep(float(os.environ["STUB_SLEEP"]))
        results = next(
            (v for k, v in RESPONSES.items() if k in query), []
        )
        body = json.dumps({
            "mode": "hybrid",
            "namespace": "stub-docs",
            "results": results,
            "runId": f"run_stub_{abs(hash(query)) % 10000}",
            "topK": 5,
            "totalCandidates": len(results),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep test output clean


HTTPServer(("127.0.0.1", int(os.environ["STUB_PORT"])), Handler).serve_forever()
PYEOF

# Result shape mirrors apps/knowledge-retrieval contract.ts (subset used).
result() { # $1=chunk-id $2=score $3=source-id $4=text
  printf '{"anchors": [{"type": "heading", "value": "H"}], "chunkId": "%s", "documentId": "doc-%s", "namespace": "stub-docs", "provenance": {"ingestedAt": "2026-09-01T00:00:00Z", "ingestionEventId": "ing-1"}, "scores": {"bm25": {"rank": 1, "score": -3.2}, "fused": {"rank": 1, "score": %s}, "vector": null}, "source": {"kind": "file", "path": "%s", "sourceId": "%s", "url": null}, "tags": [], "text": "%s", "title": "T %s", "version": {"commit": "c1", "createdAt": "2026-09-01T00:00:00Z", "status": "current", "versionId": "v1"}}' "$1" "$1" "$2" "$3" "$3" "$4" "$1"
}

cat > "${FIX}/responses.json" << EOF
{
  "titlesig": [$(result dup-1 0.033 docs/adr.md "shared chunk text"), $(result unique-2 0.030 docs/other.md "unique chunk two"), $(result low-1 0.001 docs/low.md "low relevance chunk")],
  "bodysig": [$(result dup-1 0.031 docs/adr.md "shared chunk text")]
}
EOF

# Fixture issue: title + body both carry signature tokens; body carries a path.
cat > "${FIX}/issue.json" << 'EOF'
{ "number": 86, "title": "titlesig issue", "body": "bodysig body touches deploy/tailscale/base/serve-fixer-cm.yaml", "url": "https://github.com/gwkline/homelab/issues/86" }
EOF

PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
STUB_PORT="${PORT}" STUB_RESPONSES="${FIX}/responses.json" \
  python3 "${FIX}/stub.py" > "${FIX}/stub.log" 2>&1 &
STUB_PID=$!
trap 'kill "${STUB_PID}" 2>/dev/null || true; rm -rf "$FIX"' EXIT
i=0
while ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done

# assert_record: helper to pull a value out of the produced record
assert_eq() { # $1=desc $2=actual $3=expected
  if [ "${2}" != "${3}" ]; then
    echo "FAIL: $1 — got '${2}', expected '${3}'"
    exit 1
  fi
}

# --- 1. ok path ------------------------------------------------------------------
printf 'stub-token' > "${FIX}/token"
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN_FILE="${FIX}/token" KNOWLEDGE_NAMESPACE="stub-docs" \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-ok.json" 2> "${FIX}/log-ok"

python3 - "${FIX}/out-ok.json" << 'PYEOF'
import json, sys

k = json.load(open(sys.argv[1]))
assert k["status"] == "ok", k["status"]
assert k["namespace"] == "stub-docs"
assert k["error"] is None
assert len(k["citations"]) == 3, len(k["citations"])  # dup-1 deduped across queries
assert [c["id"] for c in k["citations"]] == ["K1", "K2", "K3"]
assert k["citations"][0]["chunk_id"] == "dup-1"  # best fused score first
assert k["citations"][0]["retrieved_by"] == ["title", "body"]  # retrieved by both queries
assert k["citations"][0]["source"]["path"] == "docs/adr.md"
assert k["citations"][0]["version"]["version_id"] == "v1"
assert k["citations"][2]["chunk_id"] == "low-1"  # min_score=0 keeps everything
assert len(k["service_run_ids"]) == 2  # one per derived query that matched
assert len(k["queries"]) == 3, k["queries"]  # title + body + paths
assert k["queries"][2]["kind"] == "paths"
assert k["queries"][0]["results"] > 0
assert k["retrieval"]["max_chunks"] == 8
print("ok-path record shape proven")
PYEOF
grep -q "titlesig" "${FIX}/out-ok.json" || { echo "FAIL: derived query not recorded"; exit 1; }
grep -q "serve-fixer-cm.yaml" "${FIX}/out-ok.json" || { echo "FAIL: affected-path query not recorded"; exit 1; }
echo "PASS: ok path — cited, deduped, ranked, provenance-complete"

# --- 2. budget knobs ---------------------------------------------------------------
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN=stub-token KNOWLEDGE_MIN_SCORE=0.01 \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-score.json" 2> /dev/null
assert_eq "min_score filter" "$(python3 -c 'import json;print(len(json.load(open("'"${FIX}"'/out-score.json"))["citations"]))')" "2"

KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN=stub-token KNOWLEDGE_BUDGET_CHARS=30 \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-budget.json" 2> /dev/null
assert_eq "char budget keeps whole chunks only" "$(python3 -c 'import json;print(len(json.load(open("'"${FIX}"'/out-budget.json"))["citations"]))')" "1"

KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN=stub-token KNOWLEDGE_MAX_CHUNKS=2 \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-cap.json" 2> /dev/null
assert_eq "max_chunks cap" "$(python3 -c 'import json;print(len(json.load(open("'"${FIX}"'/out-cap.json"))["citations"]))')" "2"
echo "PASS: explicit budget — min_score, char budget, chunk cap"

# --- 3. fail-open paths --------------------------------------------------------------
# Connection refused (nothing on this port):
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:9/v1/search" \
  KNOWLEDGE_TOKEN=stub-token \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-refused.json" 2> /dev/null
assert_eq "conn refused status" "$(python3 -c 'import json;print(json.load(open("'"${FIX}"'/out-refused.json"))["status"])')" "unavailable"

# HTTP 401 (stub restarted with STUB_AUTH_FAIL=1):
kill "${STUB_PID}" 2>/dev/null || true
STUB_PORT="${PORT}" STUB_RESPONSES="${FIX}/responses.json" STUB_AUTH_FAIL=1 \
  python3 "${FIX}/stub.py" > "${FIX}/stub401.log" 2>&1 &
STUB_PID=$!
i=0
while ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN=wrong-token \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-401.json" 2> /dev/null
assert_eq "auth failure status" "$(python3 -c 'import json;print(json.load(open("'"${FIX}"'/out-401.json"))["status"])')" "unavailable"
grep -q "unauthorized" "${FIX}/out-401.json" || { echo "FAIL: 401 reason not recorded"; exit 1; }

# Timeout (server stalls 3s, client deadline 1s):
kill "${STUB_PID}" 2>/dev/null || true
STUB_PORT="${PORT}" STUB_RESPONSES="${FIX}/responses.json" STUB_SLEEP=3 \
  python3 "${FIX}/stub.py" > "${FIX}/stub-slow.log" 2>&1 &
STUB_PID=$!
i=0
while ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  KNOWLEDGE_TOKEN=stub-token KNOWLEDGE_TIMEOUT=1 \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-timeout.json" 2> /dev/null
assert_eq "timeout status" "$(python3 -c 'import json;print(json.load(open("'"${FIX}"'/out-timeout.json"))["status"])')" "timeout"

# Disabled (no URL configured):
sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-disabled.json" 2> /dev/null
assert_eq "disabled status" "$(python3 -c 'import json;print(json.load(open("'"${FIX}"'/out-disabled.json"))["status"])')" "disabled"

# Missing token with URL configured:
KNOWLEDGE_SEARCH_URL="http://127.0.0.1:${PORT}/v1/search" \
  sh "${KC}" gwkline/homelab "${FIX}/issue.json" "${FIX}/out-notoken.json" 2> /dev/null
assert_eq "missing-token status" "$(python3 -c 'import json;print(json.load(open("'"${FIX}"'/out-notoken.json"))["status"])')" "unavailable"
echo "PASS: fail-open — refused/401/timeout/disabled/no-token all exit 0 with explicit status"

# Every failure record must still be a valid brief-shaped knowledge section.
for f in out-refused out-401 out-timeout out-disabled out-notoken; do
  python3 - "${FIX}/${f}.json" << 'PYEOF'
import json, sys

k = json.load(open(sys.argv[1]))
assert k["citations"] == []
assert k["queries"] == []
assert k["retrieval"]["max_chunks"] > 0
PYEOF
done

# Lint the script under test with the same dialect CI uses (when available).
if [ -n "${SHELLCHECK}" ] && [ -x "${SHELLCHECK}" ]; then
  "${SHELLCHECK}" -s sh "${KC}"
fi

echo "ALL KNOWLEDGE-CONTEXT TESTS PASSED"