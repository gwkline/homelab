#!/usr/bin/env python3
"""Full-history Gmail Sent drain for gavin-voice corpus v4.

The 2026-11-19 mandate lifts the standing EMAIL_MIN_DATE rule: mine ALL sent
mail back to account start. The v3 fetch had listed 2,215 ids across 5 pages
with more_pages_exist=True and 1,718 ids never fetched (the 2013-2020 tail,
previously dropped by the min-date rule, now wanted).

Drives the executor MCP endpoint (http://localhost:4789/mcp) directly from a
local script per the executor-mcp-runtime skill: bulk Gmail exports die with
the sandbox session (~130-300 calls / ~3 min budget), so work is chunked with
a persisted, id-keyed, resumable cursor; a fresh JSON-RPC session runs the
MCP initialize handshake before tools/call; 403s are quota bursts (backoff
and retry, never re-auth); requests are paced because a sibling full-mailbox
consumer is live. Base64 bodies are decoded OUTSIDE the sandbox (QuickJS has
no TextDecoder).

Bodies KEEP the quoted "On ... wrote:" block — build_corpus.py does all
cleaning and v3's thread-aware grounding depends on it. html-only messages
get a best-effort tag strip in Python and are marked body_src=html.

Never prints message bodies or the bearer. Read-only against Gmail.

Usage:
  python3 scripts/gmail_drain_v4.py list    # paginate in:sent to exhaustion
  python3 scripts/gmail_drain_v4.py fetch   # fetch missing ids in chunks
  python3 scripts/gmail_drain_v4.py status  # local-only coverage report
"""
import base64
import glob
import html as htmlmod
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
BATCH_DIR = f"{D}/corpus/email_batches"
IDS_PATH = f"{BATCH_DIR}/all_sent_ids_v4.json"
LOG = open(f"{D}/logs/gmail_drain_v4.log", "a", buffering=1)

MCP_URL = "http://localhost:4789/mcp"
PROTO = "2024-11-05"
CHUNK = int(os.environ.get("DRAIN_CHUNK", "120"))
CHUNK_PAUSE = float(os.environ.get("DRAIN_PAUSE", "5"))
QUOTA_SLEEP = float(os.environ.get("DRAIN_QUOTA_SLEEP", "90"))
BODY_CAP = 8000


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
    LOG.write(line + "\n")


def load_bearer():
    """Bearer for the local executor MCP from ~/.hermes/config.yaml.
    Never printed or logged."""
    text = open(os.path.expanduser("~/.hermes/config.yaml")).read()
    m = re.search(r"executor:\n(?:.*\n)*?\s*headers:\n\s*Authorization:\s*(.+)$",
                  text, re.M)
    if not m or not m.group(1).strip():
        raise SystemExit("no executor Authorization header found in config")
    return m.group(1).strip()


AUTH = ""


# ------------------------------------------------------------- MCP session
class MCPSession:
    def __init__(self):
        self.headers = {"Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                        "Authorization": AUTH}
        self.rid = 0
        self._init()

    def _post(self, payload, timeout=290):
        req = urllib.request.Request(
            MCP_URL, data=json.dumps(payload).encode(), headers=self.headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            sid = resp.headers.get("mcp-session-id")
            if sid and "mcp-session-id" not in self.headers:
                self.headers["mcp-session-id"] = sid
            return self._parse(resp.read().decode("utf-8", "replace"))

    @staticmethod
    def _parse(text):
        if text.lstrip().startswith("{"):
            return json.loads(text)
        # SSE framing: take the last data: line(s) that parse as JSON-RPC
        best = None
        for m in re.finditer(r"^data:\s*(.+)$", text, re.M):
            try:
                d = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            best = d
        return best

    def _init(self):
        r = self._post({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                        "params": {"protocolVersion": PROTO,
                                   "capabilities": {},
                                   "clientInfo": {"name": "gavin-drain",
                                                  "version": "1.0"}}},
                       timeout=60)
        if not r or "result" not in r:
            raise RuntimeError(f"initialize failed: {str(r)[:200]}")
        try:
            self._post({"jsonrpc": "2.0",
                        "method": "notifications/initialized"}, timeout=30)
        except Exception:
            pass

    def call(self, code, timeout=290):
        self.rid += 1
        rid = self.rid
        r = self._post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                        "params": {"name": "execute",
                                   "arguments": {"code": code}}},
                        timeout=timeout)
        if not r:
            raise RuntimeError("empty tools/call response")
        if r.get("error"):
            raise RuntimeError(f"tools/call error: {str(r['error'])[:200]}")
        res = r.get("result", {})
        if isinstance(res.get("content"), list):
            text = "\n".join(c.get("text", "") for c in res["content"]
                             if isinstance(c, dict))
        else:
            text = json.dumps(res)
        return text


def execute_js(code, max_tries=3):
    """Run sandbox code; rotate to a fresh session per attempt (the first
    call of a fresh session can fail once — retry, don't conclude)."""
    last = None
    for attempt in range(max_tries):
        try:
            s = MCPSession()
            return s.call(code)
        except Exception as e:
            last = e
            log(f"execute attempt {attempt + 1} failed: {str(e)[:120]}; "
                f"rotating session")
            time.sleep(3 + 5 * attempt)
    raise RuntimeError(f"execute_js giving up: {last}")


# ------------------------------------------------------------ sandbox code
LIST_JS = """
const ids = [];
let token = null;
let pages = 0;
let err = null;
for (let guard = 0; guard < 60; guard++) {
  const args = { userId: 'me', q: 'in:sent', maxResults: 500 };
  if (token) args.pageToken = token;
  let r = await tools.google_gmail.org.localgmail.gmail.users.messages.list(args);
  if (!r || r.ok === false) {
    err = (r && r.error && (String(r.error.code || '') + ' ' +
           String(r.error.message || ''))) || 'no-data';
    break;
  }
  const d = r.data || r;
  const msgs = d.messages || [];
  for (const m of msgs) ids.push(m.id);
  pages++;
  token = d.nextPageToken || null;
  if (!token) break;
}
console.log(JSON.stringify({ ids: ids, pages: pages, error: err }));
"""


def fetch_js(ids):
    return """
const ids = %s;
const out = [];
function hdr(m, name) {
  const h = (m.payload && m.payload.headers) || [];
  for (const x of h) if (x.name && x.name.toLowerCase() === name.toLowerCase()) return x.value;
  return '';
}
for (const id of ids) {
  try {
    const r = await tools.google_gmail.org.localgmail.gmail.users.messages.get(
      { userId: 'me', id: id, format: 'full' });
    if (!r || r.ok === false) {
      const em = (r && r.error &&
                  (String(r.error.code || '') + ' ' + String(r.error.message || '').slice(0, 80))) || 'no-data';
      out.push(JSON.stringify({ id: id, error: em.slice(0, 120) }));
      continue;
    }
    const m = r.data || r;
    let part = null;
    (function walk(p) {
      if (!p || part) return;
      if (p.mimeType === 'text/plain' && p.body && p.body.data) { part = p; return; }
      if (p.parts) for (const c of p.parts) { if (!part) walk(c); }
    })(m.payload);
    let mime = part ? part.mimeType : '';
    let data = part ? part.body.data : '';
    if (!data && m.payload && m.payload.body && m.payload.body.data) {
      data = m.payload.body.data;
      mime = m.payload.mimeType || '';
    }
    if (!data) {
      (function walkh(p) {
        if (!p || data) return;
        if (p.mimeType === 'text/html' && p.body && p.body.data) { data = p.body.data; mime = p.mimeType; return; }
        if (p.parts) for (const c of p.parts) { if (!data) walkh(c); }
      })(m.payload);
    }
    out.push(JSON.stringify({ id: id, date: hdr(m, 'Date'), to: hdr(m, 'To'),
                              subject: hdr(m, 'Subject'), mime: mime,
                              body_b64: data || '' }));
  } catch (e) {
    out.push(JSON.stringify({ id: id, error: String(e).slice(0, 120) }));
  }
}
console.log(out.join('\\n'));
""" % json.dumps(ids)


# --------------------------------------------------------------- decoding
TAG_BLOCK = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def b64_to_text(s):
    s = s.replace("-", "+").replace("_", "/")
    raw = base64.b64decode(s + "=" * (-len(s) % 4))
    return raw.decode("utf-8", "replace")


def html_to_text(h):
    h = TAG_BLOCK.sub(" ", h)
    h = re.sub(r"(?i)<br\s*/?>", "\n", h)
    h = re.sub(r"(?i)</(p|div|tr|li)>", "\n", h)
    h = TAG.sub(" ", h)
    h = htmlmod.unescape(h)
    h = re.sub(r"[ \t]+\n", "\n", h)
    h = re.sub(r"\n{3,}", "\n\n", h)
    return h.strip()


def parse_records(text):
    """Scan a tools/call response for {\"id\": ...} JSON objects (the skill's
    raw_decode pattern; spillover wrappers can duplicate escaped copies)."""
    dec = json.JSONDecoder()
    seen = {}
    for m in re.finditer(r'\{"id":', text):
        try:
            rec, _ = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "id" in rec and "error" not in rec:
            seen[rec["id"]] = rec
    return seen


def parse_errors(text):
    """Error rows via raw_decode (escaped quotes inside error strings break
    regex value capture). Returns {id: error_string}."""
    dec = json.JSONDecoder()
    seen = {}
    for m in re.finditer(r'\{"id":', text):
        try:
            rec, _ = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "id" in rec and "error" in rec:
            seen[rec["id"]] = str(rec["error"])
    return seen


# ------------------------------------------------------------- local state
def fetched_ids():
    ids = set()
    for path in sorted(glob.glob(f"{BATCH_DIR}/batch*.txt")):
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for m in re.finditer(r'\{"id":\s*"([^"]+)"', text):
            ids.add(m.group(1))
        for m in re.finditer(r'\{"id":\s*"([^"]+)"[^}]*"error"', text):
            ids.discard(m.group(1))  # error rows are not fetched
    return ids


def append_batch(chunk_no, records):
    path = f"{BATCH_DIR}/batch_v4_{chunk_no}.txt"
    with open(path, "a", encoding="utf-8") as f:
        for rec in records:
            body, src = "", ""
            b64 = rec.get("body_b64") or ""
            if b64:
                try:
                    body = b64_to_text(b64)
                    src = "html" if "html" in (rec.get("mime") or "") else "plain"
                    if src == "html":
                        body = html_to_text(body)
                except Exception as e:
                    body, src = "", f"decode_error:{type(e).__name__}"
                if len(body) > BODY_CAP:
                    body = body[:BODY_CAP]
                    rec["truncated"] = True
            out = {"id": rec["id"], "date": rec.get("date", ""),
                   "to": rec.get("to", ""), "subject": rec.get("subject", ""),
                   "body": body, "body_src": src}
            if rec.get("truncated"):
                out["truncated"] = True
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
    return path


# ------------------------------------------------------------------ phases
def phase_list():
    text = execute_js(LIST_JS)
    m = re.search(r'\{"ids":', text)
    if not m:
        raise SystemExit("listing produced no ids object; first 300 chars: "
                         + text[:300].replace("\n", " "))
    dec = json.JSONDecoder()
    obj, _ = dec.raw_decode(text, m.start())
    if obj.get("error"):
        log(f"LIST WARNING: last page error: {obj['error'][:120]}")
    ids = obj["ids"]
    # union with the old partial listing (it was cut off; new one wins)
    old = f"{BATCH_DIR}/all_sent_ids.json"
    if os.path.exists(old):
        old_ids = set(json.load(open(old)).get("ids", []))
        added = old_ids - set(ids)
        if added:
            log(f"old listing contributed {len(added)} ids missing from new")
            ids = list(dict.fromkeys(ids + sorted(added)))
    json.dump({"ids": ids, "pages": obj.get("pages"),
               "total": len(ids), "listed_at": time.strftime("%FT%T")},
              open(IDS_PATH, "w"), indent=1)
    log(f"listed {len(ids)} sent ids across {obj.get('pages')} pages -> "
        f"{os.path.basename(IDS_PATH)}")


def phase_fetch():
    listed = json.load(open(IDS_PATH))["ids"]
    done = fetched_ids()
    missing = [i for i in listed if i not in done]
    log(f"fetch start: listed={len(listed)} already_fetched={len(done)} "
        f"missing={len(missing)}")
    chunk_no = 1 + len(glob.glob(f"{BATCH_DIR}/batch_v4_*.txt"))
    rounds_no_progress = 0
    retries = {}
    quota_backoff = QUOTA_SLEEP
    while missing:
        chunk, missing = missing[:CHUNK], missing[CHUNK:]
        text = execute_js(fetch_js(chunk))
        recs = parse_records(text)
        errs = parse_errors(text)
        ok = [chunk_id for chunk_id in chunk if chunk_id in recs]
        # idempotence: only append ids not already on disk
        on_disk = fetched_ids()
        new = [recs[i] for i in ok if i not in on_disk]
        if new:
            path = append_batch(chunk_no, new)
            chunk_no += 1
        def is_quota(e):
            return "403" in e or "429" in e or "rejected credentials" in e
        n_quota = sum(1 for e in errs.values() if is_quota(e))
        log(f"chunk of {len(chunk)}: ok={len(ok)} errors={len(errs)} "
            f"(quota={n_quota}) new_written={len(new)}")
        quota_ids = [i for i, e in errs.items() if is_quota(e)]
        hard_ids = [i for i, e in errs.items() if not is_quota(e)]
        for bad in hard_ids:
            retries[bad] = retries.get(bad, 0) + 1
        give_up = [i for i, n in retries.items() if n >= 3]
        if give_up:
            log(f"giving up on {len(give_up)} ids after 3 hard failures")
        retry_hard = [i for i in hard_ids if retries.get(i, 0) < 3]
        if n_quota:
            log(f"quota burst ({n_quota} ids); backing off {quota_backoff:.0f}s "
                f"(clears on its own — never re-auth)")
            time.sleep(quota_backoff)
            quota_backoff = min(quota_backoff + 30, 300)
            missing = quota_ids + retry_hard + missing
        else:
            quota_backoff = max(QUOTA_SLEEP, quota_backoff - 30)
            if len(ok) == 0 and not errs:
                rounds_no_progress += 1
                missing = chunk + missing
                if rounds_no_progress >= 3:
                    log("no progress 3 rounds; stopping to avoid a hot loop")
                    break
                time.sleep(30)
            else:
                rounds_no_progress = 0
                missing = retry_hard + missing if retry_hard else missing
        time.sleep(CHUNK_PAUSE)
    final = fetched_ids()
    still = [i for i in listed if i not in final]
    log(f"fetch done: fetched_total={len(final)} still_missing={len(still)}")


def phase_status():
    listed = json.load(open(IDS_PATH))["ids"] if os.path.exists(IDS_PATH) else []
    done = fetched_ids()
    missing = [i for i in listed if i not in done]
    print(json.dumps({
        "listed": len(listed), "fetched": len(done & set(listed)),
        "missing": len(missing),
        "batch_files": len(glob.glob(f"{BATCH_DIR}/batch*.txt")),
        "v4_batches": sorted(os.path.basename(p) for p in
                             glob.glob(f"{BATCH_DIR}/batch_v4_*.txt")),
    }, indent=1))


if __name__ == "__main__":
    AUTH = load_bearer()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"list": phase_list, "fetch": phase_fetch,
     "status": phase_status}[cmd]()
