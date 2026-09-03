#!/bin/sh
# Knowledge context assembly for coding-run briefs (#86).
#
# Queries the knowledge-retrieval service (apps/knowledge-retrieval) for
# context relevant to one factory issue and writes a compact, cited,
# budget-bounded record that run.sh embeds into the worker brief. The record
# carries the exact queries, the retrieval configuration, and every selected
# citation with full provenance, so the Run can show where its context came
# from.
#
# Fail-open by contract: this script ALWAYS exits 0 and ALWAYS writes the
# record file. The record's status field says exactly what happened:
#   ok          — citations selected (zero survivors is "empty", not "ok")
#   empty       — service answered, nothing relevant survived the filters
#   disabled    - KNOWLEDGE_SEARCH_URL unset; feature off for this run
#   unavailable — service unreachable, auth failure, non-200, bad payload
#   timeout     — a request exceeded KNOWLEDGE_TIMEOUT seconds
# A knowledge outage never fails a run: the worker proceeds WITHOUT context
# and the status (with the reason) is visible in the run comment.
#
# Configuration (env, all optional):
#   KNOWLEDGE_SEARCH_URL    full .../v1/search URL; unset = disabled
#   KNOWLEDGE_TOKEN_FILE    bearer token file (secret-backed, preferred)
#   KNOWLEDGE_TOKEN         bearer token (fallback when no file is mounted)
#   KNOWLEDGE_NAMESPACE     retrieval namespace       (default: default)
#   KNOWLEDGE_MODE          bm25 | vector | hybrid   (default: hybrid)
#   KNOWLEDGE_TOP_K         per-query k              (default: 5)
#   KNOWLEDGE_TIMEOUT       per-request seconds      (default: 5)
#   KNOWLEDGE_BUDGET_CHARS  total citation text budget (default: 6000)
#   KNOWLEDGE_MAX_CHUNKS    max citations injected   (default: 8)
#   KNOWLEDGE_MAX_SOURCES   max distinct sources     (default: 4)
#   KNOWLEDGE_MIN_SCORE     minimum fused RRF score  (default: 0 = rank-only)
#
# Budget rules (explicit, applied in this order after the score filter):
#   1. dedupe by chunkId across queries (best fused score wins)
#   2. sort by fused score desc, chunkId asc (deterministic)
#   3. cap distinct sources at KNOWLEDGE_MAX_SOURCES (by rank order)
#   4. cap citation count at KNOWLEDGE_MAX_CHUNKS
#   5. whole-chunk fit into KNOWLEDGE_BUDGET_CHARS (never truncated text)
#
# Deployment note: sandbox egress policy blocks in-cluster service CIDRs for
# orchestrator pods; wiring a real URL requires a named egress allowance next
# to the knowledge service manifests (docs/egress-policy.md).
#
# Usage: knowledge-context.sh <owner/name> <issue.json> <out-record.json>
set -eu

REPO="${1:?usage: knowledge-context.sh <owner/name> <issue.json> <out.json>}"
ISSUE_FILE="${2:?missing issue.json path}"
OUT_FILE="${3:?missing output record path}"

KNOWLEDGE_NAMESPACE="${KNOWLEDGE_NAMESPACE:-default}"
KNOWLEDGE_MODE="${KNOWLEDGE_MODE:-hybrid}"
KNOWLEDGE_TOP_K="${KNOWLEDGE_TOP_K:-5}"
KNOWLEDGE_TIMEOUT="${KNOWLEDGE_TIMEOUT:-5}"
KNOWLEDGE_BUDGET_CHARS="${KNOWLEDGE_BUDGET_CHARS:-6000}"
KNOWLEDGE_MAX_CHUNKS="${KNOWLEDGE_MAX_CHUNKS:-8}"
KNOWLEDGE_MAX_SOURCES="${KNOWLEDGE_MAX_SOURCES:-4}"
KNOWLEDGE_MIN_SCORE="${KNOWLEDGE_MIN_SCORE:-0}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-ctx.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
QUERIES_FILE="${WORK}/queries.json"

# emit_record: write the record via python so status/reason are always valid
# JSON, even on the failure paths (run.sh embeds it verbatim into the brief).
# $1=status  $2=error-reason  [$3=queries-json]  [$4=service-run-ids-json]
# [$5=citations-json]
emit_record() {
  python3 - "${REPO}" "${OUT_FILE}" "$1" "${2:-}" \
    "${3:-[]}" "${4:-[]}" "${5:-[]}" \
    "${KNOWLEDGE_NAMESPACE}" "${KNOWLEDGE_MODE}" "${KNOWLEDGE_TOP_K}" \
    "${KNOWLEDGE_TIMEOUT}" "${KNOWLEDGE_BUDGET_CHARS}" \
    "${KNOWLEDGE_MAX_CHUNKS}" "${KNOWLEDGE_MAX_SOURCES}" \
    "${KNOWLEDGE_MIN_SCORE}" << 'PYEOF'
import json, sys

(
    _,
    _repo,
    out_file,
    status,
    error,
    queries,
    run_ids,
    citations,
    namespace,
    mode,
    top_k,
    timeout,
    budget,
    max_chunks,
    max_sources,
    min_score,
) = sys.argv
record = {
    "status": status,
    "error": error or None,
    "namespace": namespace,
    "service_run_ids": json.loads(run_ids),
    "queries": json.loads(queries),
    "retrieval": {
        "mode": mode,
        "top_k": int(top_k),
        "timeout_seconds": int(timeout),
        "budget_chars": int(budget),
        "max_chunks": int(max_chunks),
        "max_sources": int(max_sources),
        "min_score": float(min_score),
    },
    "citations": json.loads(citations),
}
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")
PYEOF
}

fail_record() { # $1=status $2=reason
  emit_record "$1" "$2"
  echo "[knowledge] $1: $2 — run proceeds WITHOUT context" >&2
  exit 0
}

# --- token: secret-backed, file mount preferred ------------------------------
TOKEN="${KNOWLEDGE_TOKEN:-}"
if [ -z "${TOKEN}" ] && [ -n "${KNOWLEDGE_TOKEN_FILE:-}" ] && [ -r "${KNOWLEDGE_TOKEN_FILE}" ]; then
  TOKEN="$(tr -d '[:space:]' < "${KNOWLEDGE_TOKEN_FILE}")"
fi

# --- 1. gate: feature disabled without a configured service ------------------
if [ -z "${KNOWLEDGE_SEARCH_URL:-}" ]; then
  fail_record "disabled" "KNOWLEDGE_SEARCH_URL not set"
fi
if [ -z "${TOKEN}" ]; then
  fail_record "unavailable" "no knowledge token configured (KNOWLEDGE_TOKEN/KNOWLEDGE_TOKEN_FILE)"
fi

[ -r "${ISSUE_FILE}" ] || fail_record "unavailable" "issue record ${ISSUE_FILE} unreadable"

# --- 2. derive queries from repo + issue title/body + affected paths ---------
# "Affected paths when known": path-like tokens (dir/file and file.ext) found
# in the issue text become their own query — the only path signal the
# orchestrator has at brief-assembly time.
python3 - "${REPO}" "${ISSUE_FILE}" "${QUERIES_FILE}" << 'PYEOF' || fail_record "unavailable" "query derivation failed"
import json, re, sys

repo, issue_file, out_file = sys.argv[1:4]
issue = json.load(open(issue_file, encoding="utf-8"))
title = (issue.get("title") or "").strip()
body = issue.get("body") or ""
repo_name = repo.split("/")[-1] if repo else ""

queries = []


def add(kind, text):
    q = re.sub(r"\s+", " ", text).strip()
    if q:
        queries.append({"kind": kind, "query": q[:500], "results": 0})


if title:
    add("title", f"{repo_name} {title}")
flat_body = re.sub(r"\s+", " ", body).strip()
if flat_body:
    add("body", flat_body[:400])
tokens = []
for pat in (
    r"[A-Za-z0-9][\w.\-]*/[\w.\-]+",
    r"[\w\-]+\.(?:sh|ts|tsx|js|mjs|cjs|json|ya?ml|md|sql|py|go|rs|toml|tf)",
):
    for m in re.finditer(pat, body):
        tok = m.group(0)
        if tok not in tokens:
            tokens.append(tok)
if tokens:
    add("paths", " ".join(tokens[:5]))

seen, unique = set(), []
for q in queries:
    if q["query"] not in seen:
        seen.add(q["query"])
        unique.append(q)
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(unique, fh)
print(f"[knowledge] derived {len(unique)} query/ies (title/body/paths from issue + repo)")
PYEOF

N_QUERIES=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "${QUERIES_FILE}")
if [ "${N_QUERIES}" -eq 0 ]; then
  fail_record "empty" "no usable queries could be derived from the issue"
fi

# --- 3. retrieve per query (timeout-wrapped, explicit failures) --------------
i=0
while [ "${i}" -lt "${N_QUERIES}" ]; do
  i=$((i + 1))
  RESP="${WORK}/resp-${i}.json"
  BODY=$(jq -c ".[$((i - 1))]" "${QUERIES_FILE}")
  CURL_RC=0
  HTTP_CODE=""
  if ! HTTP_CODE=$(curl -sS --max-time "${KNOWLEDGE_TIMEOUT}" \
      -o "${RESP}" -w '%{http_code}' \
      -H "Authorization: Bearer ${TOKEN}" \
      -H 'Content-Type: application/json' \
      -X POST -d "${BODY}" "${KNOWLEDGE_SEARCH_URL}" 2>"${WORK}/curl.err"); then
    CURL_RC=$?
  fi
  if [ "${CURL_RC}" -eq 28 ]; then
    fail_record "timeout" "query ${i} exceeded ${KNOWLEDGE_TIMEOUT}s (knowledge-service deadline)"
  elif [ "${CURL_RC}" -ne 0 ]; then
    fail_record "unavailable" "query ${i} failed: $(tr '\n' ' ' < "${WORK}/curl.err" | head -c 200)"
  elif [ "${HTTP_CODE}" != "200" ]; then
    ERR_CODE=$(jq -r '.error.code // empty' "${RESP}" 2>/dev/null || true)
    fail_record "unavailable" "query ${i} got HTTP ${HTTP_CODE}${ERR_CODE:+ (${ERR_CODE})}"
  elif ! jq -e '.results | type == "array"' "${RESP}" >/dev/null 2>&1; then
    fail_record "unavailable" "query ${i} returned an unparseable response"
  fi
done

# --- 4. merge, budget, cite ----------------------------------------------------
# Dedupe by chunkId across queries → score filter → deterministic sort →
# source cap → chunk cap → whole-chunk char budget → stable K<n> ids.
python3 - "${WORK}" "${N_QUERIES}" "${OUT_FILE}" \
  "${KNOWLEDGE_BUDGET_CHARS}" "${KNOWLEDGE_MAX_CHUNKS}" \
  "${KNOWLEDGE_MAX_SOURCES}" "${KNOWLEDGE_MIN_SCORE}" \
  "${KNOWLEDGE_NAMESPACE}" "${KNOWLEDGE_MODE}" "${KNOWLEDGE_TOP_K}" \
  "${KNOWLEDGE_TIMEOUT}" << 'PYEOF' || fail_record "unavailable" "citation assembly failed"
import json, os, re, sys

(
    _,
    work,
    out_file,
    budget,
    max_chunks,
    max_sources,
    min_score,
    namespace,
    mode,
    top_k,
    timeout,
) = sys.argv
budget, max_chunks, max_sources, min_score = (
    float(budget),
    int(max_chunks),
    int(max_sources),
    float(min_score),
)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

queries = json.load(open(os.path.join(work, "queries.json"), encoding="utf-8"))
run_ids, candidates = [], []
for i in range(1, len(queries) + 1):
    resp = json.load(open(os.path.join(work, f"resp-{i}.json"), encoding="utf-8"))
    if resp.get("runId"):
        run_ids.append(resp["runId"])
    queries[i - 1]["results"] = len(resp.get("results") or [])
    kind = queries[i - 1]["kind"]
    for r in resp.get("results") or []:
        if not isinstance(r, dict) or not r.get("chunkId") or not r.get("text"):
            continue  # a result without identity/text is not a citable chunk
        score = ((r.get("scores") or {}).get("fused") or {}).get("score") or 0.0
        if score < min_score:
            continue
        src, ver = r.get("source") or {}, r.get("version") or {}
        entry = {
            "chunk_id": r["chunkId"],
            "document_id": r.get("documentId"),
            "title": ANSI.sub("", r.get("title") or "").strip(),
            "text": ANSI.sub("", r["text"]).replace("\r\n", "\n").strip(),
            "score": round(score, 6),
            "retrieved_by": [kind],
            "source": {
                "kind": src.get("kind"),
                "source_id": src.get("sourceId"),
                "path": src.get("path"),
                "url": src.get("url"),
            },
            "version": {
                "version_id": ver.get("versionId"),
                "commit": ver.get("commit"),
                "created_at": ver.get("createdAt"),
                "status": ver.get("status"),
            },
            "anchors": r.get("anchors") or [],
        }
        prev = next(
            (c for c in candidates if c["chunk_id"] == entry["chunk_id"]), None
        )
        if prev:  # dedupe across queries; best fused score wins
            if entry["score"] >= prev["score"]:
                if entry["score"] > prev["score"]:
                    prev["score"] = entry["score"]
                prev["retrieved_by"].append(kind)
            continue
        candidates.append(entry)

candidates.sort(key=lambda c: (-c["score"], c["chunk_id"]))
kept, seen_sources, used = [], [], 0
for c in candidates:
    if len(kept) >= max_chunks:
        break
    sid = c["source"].get("source_id") or c["document_id"] or c["chunk_id"]
    if sid not in seen_sources and len(seen_sources) >= max_sources:
        continue
    if used + len(c["text"]) > budget:
        continue  # whole-chunk fit: never inject truncated text
    if sid not in seen_sources:
        seen_sources.append(sid)
    kept.append(c)
    used += len(c["text"])
for n, c in enumerate(kept, start=1):
    c["id"] = f"K{n}"

record = {
    "status": "ok" if kept else "empty",
    "error": None,
    "namespace": namespace,
    "service_run_ids": run_ids,
    "queries": queries,
    "retrieval": {
        "mode": mode,
        "top_k": int(top_k),
        "timeout_seconds": int(timeout),
        "budget_chars": int(budget),
        "max_chunks": max_chunks,
        "max_sources": max_sources,
        "min_score": min_score,
    },
    "citations": kept,
}
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")
print(
    f"[knowledge] {record['status']}: {len(kept)} citation(s), "
    f"{len(seen_sources)} source(s), {used}/{int(budget)} chars, "
    f"{len(run_ids)} retrieval request(s), namespace {namespace}"
)
PYEOF

echo "[knowledge] record written: ${OUT_FILE} (status $(jq -r '.status' "${OUT_FILE}"))" >&2