#!/usr/bin/env python3
"""Full-mailbox history miner for the email action classifier (v3).

Drives the Executor MCP server's JSON-RPC endpoint directly (local script +
own session rotation + cursor persistence) because the Hermes-side
mcp__executor__execute path adds a 300s call timeout that bulk jobs exceed.

Phases (each resumable; outputs are append-only + id-deduped):
  list     threads.list pagination (100/page, 40 pages per execute session)
           -> threads_manifest.jsonl + ckpt_list.json
  get      threads.get per thread (format=metadata, From/Subject/
           List-Unsubscribe/Precedence headers, 100-msg cap + tail ids)
           -> threads_raw.jsonl
  xmeta    messages.get for messages beyond the per-thread cap (rare)
           -> xmeta_raw.jsonl
  profile  users.getProfile snapshot -> profile.json
  status   print progress summary only

Every execute call runs in a FRESH MCP session (initialize handshake first —
fresh sessions that skip it return empty results that look like hangs). Log
output is parsed from structuredContent.logs (inline) — never re-fetched.

No message bodies are ever logged; only metadata headers + snippets truncated
to 170 chars, and driver stdout carries counts only.
The MCP endpoint + bearer come from the `mcp_servers.executor` block of
~/.hermes/config.yaml — nothing here holds a token itself.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

_HOME_ENV = os.environ.get("EMAIL_CLASSIFIER_HOME")
if not _HOME_ENV:
    raise SystemExit(
        "EMAIL_CLASSIFIER_HOME must point at the gitignored personal dir "
        "(~/git-dev/email-classifier-local) — the sweep data is "
        "Gmail-derived and must never land inside this repo")
HOME = Path(_HOME_ENV)
MINE = HOME / "mine"
MINE.mkdir(parents=True, exist_ok=True)

MANIFEST = MINE / "threads_manifest.jsonl"
CKPT_LIST = MINE / "ckpt_list.json"
RAW = MINE / "threads_raw.jsonl"
XRAW = MINE / "xmeta_raw.jsonl"
ERRS = MINE / "errs.jsonl"
XERRS = MINE / "xerrs.jsonl"
LOG = MINE / "driver.log"
ACTIVE = MINE / "ACTIVE_MINER.json"
PROFILE = MINE / "profile.json"

CFG_PATH = Path("/Users/gkline/.hermes/config.yaml")
LIST_PAGES_PER_CHUNK = 40
GET_CHUNK = 150           # adaptive, clamped to [40, 250]
EXEC_TIMEOUT = 240         # per tools/call, seconds
MAX_CHUNK_ATTEMPTS = 10
CHUNK_GAP_S = 4           # between execute chunks: keep the executor's
                          # per-session credential minting well under rate

STOP = False


def log(event: dict) -> None:
    event["ts"] = time.strftime("%H:%M:%S")
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")
    keys = {k: v for k, v in event.items() if k != "ts"}
    print(f"[{event['ts']}] " + json.dumps(keys), flush=True)


def rpc_setup() -> tuple[str, str]:
    cfg = CFG_PATH.read_text()
    m = re.search(
        r"executor:\n\s+headers:\n\s+Authorization:\s*(.+)\n\s+url:\s*(\S+)", cfg)
    if not m:
        raise SystemExit("cannot parse executor config")
    return m.group(1).strip(), m.group(2)


TOKEN, URL = rpc_setup()


def post(payload: dict, session: str | None = None,
         timeout: int = EXEC_TIMEOUT) -> tuple[object, str | None]:
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream",
                 "Authorization": TOKEN})
    if session:
        req.add_header("Mcp-Session-Id", session)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        sid = r.headers.get("Mcp-Session-Id")
        raw = r.read().decode()
        ctype = r.headers.get("Content-Type", "")
    if not raw.strip():
        return None, sid
    if "event-stream" in ctype:
        for line in raw.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip()), sid
        return None, sid
    return json.loads(raw), sid


def new_session() -> str:
    init, sid = post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "email-history-miner", "version": "3"}},
    })
    if not init or "result" not in init:
        raise RuntimeError(f"initialize failed: {str(init)[:200]}")
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session=sid)
    return sid


def run_code(code: str) -> list[str]:
    """One execute call in a fresh session; returns console.log lines."""
    sid = new_session()
    res, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": "execute",
                              "arguments": {"code": code}}}, session=sid)
    if not isinstance(res, dict) or "result" not in res:
        raise RuntimeError(f"tools/call bad envelope: {str(res)[:300]}")
    r = res["result"]
    sc = r.get("structuredContent") or {}
    lines: list[str] = []
    logs = sc.get("logs")
    if isinstance(logs, list):
        for entry in logs:
            s = entry if isinstance(entry, str) else json.dumps(entry)
            if s.startswith("[log] "):
                s = s[6:]
            lines.append(s)
    if not lines:
        for c in r.get("content", []):
            if c.get("type") == "text":
                lines.extend(c.get("text", "").splitlines())
    if not any(l.startswith(("PAGES_DONE", "CHUNK_DONE", "PROFILE"))
               for l in lines):
        # big outputs may spill to a file instead of coming back inline;
        # keep the raw tail so the spill format can be learned offline.
        tail = json.dumps(r)[:2000]
        with open(MINE / "chunkfail_debug.txt", "w", encoding="utf-8") as fh:
            fh.write(tail)
        raise RuntimeError(f"no completion marker; result tail saved: "
                           f"{tail[:300]}")
    return lines


# ---------------------------------------------------------------- templates

TS_PREAMBLE = """
const gmail = tools.google_gmail.org.localgmail.gmail.users;
const T = gmail.threads;
const M = gmail.messages;
const sleep = (ms) => (typeof setTimeout === "function")
  ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
async function runPaced(items, start, handle) {
  if (start >= items.length) return;
  const chunk = items.slice(start, start + 2);
  await Promise.all(chunk.map(handle));
  await sleep(50);
  await runPaced(items, start + 2, handle);
}
"""

TS_LIST = TS_PREAMBLE + """
const PAGES = %d;
let TOK = %s;
let done = 0;
async function page(p) {
  if (p >= PAGES || TOK === null) { return; }  const args = { maxResults: 100, userId: "me" };
  if (TOK) args.pageToken = TOK;
  let r = await T.list(args);
  if (!r.ok) { await sleep(400); r = await T.list(args); }
  if (!r.ok) { console.log("TLFAIL " + JSON.stringify(r.error).slice(0, 150)); return; }
  const ids = (r.data?.threads ?? []).map((t) => t.id);
  done++;
  TOK = r.data?.nextPageToken ?? null;
  console.log("TL " + JSON.stringify({ p: done, n: ids.length, ids, next: TOK }));
  if (!TOK) { console.log("LIST_END"); return; }
  await page(p + 1);
}
await page(0);
console.log("PAGES_DONE " + done);
"""

TS_GET = TS_PREAMBLE + """
const IDS = %s;
const CAP = 100;
let ok = 0, err = 0;
await runPaced(IDS, 0, async (tid) => {
  let r = await T.get({ format: "metadata", id: tid, userId: "me",
    metadataHeaders: ["From", "Subject", "List-Unsubscribe", "Precedence"] });
  if (!r.ok) {
    // one instant retry absorbs a transient single-call blip; sustained
    // 403 quota storms are handled by the driver's cooldown, not here.
    const r2 = await T.get({ format: "metadata", id: tid, userId: "me",
      metadataHeaders: ["From", "Subject", "List-Unsubscribe", "Precedence"] });
    if (!r2.ok) {
      console.log("THERR " + tid + " " + JSON.stringify(r2.error).slice(0, 120));
      err++; return;
    }
    r = r2;
  }
  const msgs = r.data?.messages ?? [];
  const m = msgs.slice(0, CAP).map((x) => {
    const h = x.payload?.headers ?? [];
    const pick = (n) => { const hh = h.find((q) => q.name === n);
      return hh ? String(hh.value ?? "") : ""; };
    return { i: x.id, d: Number(x.internalDate) || 0, L: x.labelIds ?? [],
      f: pick("From").slice(0, 90), s: pick("Subject").slice(0, 110),
      n: String(x.snippet ?? "").slice(0, 170),
      lu: pick("List-Unsubscribe") ? 1 : 0,
      pc: pick("Precedence").slice(0, 20) };
  });
  const x = msgs.length > CAP ? msgs.slice(CAP).map((q) => q.id) : [];
  ok++;
  console.log("TH " + JSON.stringify({ t: tid, n: msgs.length, m, x }));
});
console.log("CHUNK_DONE " + ok + " " + err);
"""

TS_XMETA = TS_PREAMBLE + """
const IDS = %s;
let ok = 0, err = 0;
await runPaced(IDS, 0, async (mid) => {
  const args = { format: "metadata", id: mid, userId: "me",
    metadataHeaders: ["From", "Subject", "List-Unsubscribe", "Precedence"] };
  let r = await M.get(args);
  if (!r.ok) { await sleep(400); r = await M.get(args); }
  if (!r.ok) { console.log("XMERR " + mid); err++; return; }
  const h = r.data?.payload?.headers ?? [];
  const pick = (n) => { const hh = h.find((q) => q.name === n);
    return hh ? String(hh.value ?? "") : ""; };
  ok++;
  console.log("XM " + JSON.stringify({ i: r.data.id, t: r.data.threadId,
    d: Number(r.data.internalDate) || 0, L: r.data.labelIds ?? [],
    f: pick("From").slice(0, 90), s: pick("Subject").slice(0, 110),
    n: String(r.data.snippet ?? "").slice(0, 170),
    lu: pick("List-Unsubscribe") ? 1 : 0,
    pc: pick("Precedence").slice(0, 20) }));
});
console.log("CHUNK_DONE " + ok + " " + err);
"""

TS_PROFILE = TS_PREAMBLE + """
const r = await tools.google_gmail.org.localgmail.gmail.users.getProfile(
  { userId: "me" });
console.log("PROFILE " + JSON.stringify(r.ok ? r.data : { err: r.error }));
"""


# ---------------------------------------------------------------- helpers

def load_json(path: Path, default):
    if path.exists():
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return default


def append_jsonl(path: Path, rows: list) -> None:
    if not rows:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def seen_ids(path: Path, key: str) -> set:
    out = set()
    if not path.exists():
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.add(json.loads(line)[key])
            except (json.JSONDecodeError, KeyError):
                continue
    return out


def chunk_with_retry(code_factory, tag: str) -> list[str]:
    """Run one execute chunk; retry with fresh sessions on failure."""
    global GET_CHUNK
    for attempt in range(1, MAX_CHUNK_ATTEMPTS + 1):
        if STOP:
            raise KeyboardInterrupt
        try:
            t0 = time.time()
            lines = run_code(code_factory())
            dt = time.time() - t0
            if not any(l.startswith(("PAGES_DONE", "CHUNK_DONE", "PROFILE"))
                       for l in lines):
                raise RuntimeError(
                    f"no completion marker ({len(lines)} lines, "
                    f"{sum(len(l) for l in lines)} chars)")
            return lines, dt
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001 - rotate + retry is the point
            log({"phase": tag, "event": "chunk_fail", "attempt": attempt,
                 "err": str(exc)[:160]})
            if attempt >= 3:
                time.sleep(60)
            else:
                time.sleep(2)
    raise RuntimeError(f"{tag}: chunk failed after {MAX_CHUNK_ATTEMPTS} attempts")


# ---------------------------------------------------------------- phases

def do_list() -> None:
    ckpt = load_json(CKPT_LIST, {"next_token": "", "pages": 0, "end": False})
    if ckpt.get("end"):
        log({"phase": "list", "event": "already_complete",
             "pages": ckpt["pages"]})
        return
    token = ckpt.get("next_token") or ""
    pages = ckpt.get("pages", 0)
    log({"phase": "list", "event": "start", "pages_done": pages,
          "have_token": bool(token)})
    while not ckpt.get("end") and not STOP:
        # fresh start = "" (falsy but not null, so page(0) runs);
        # only a page that returns no nextToken sets TOK to null.
        tok_literal = json.dumps(token)
        lines, dt = chunk_with_retry(
            lambda: TS_LIST % (LIST_PAGES_PER_CHUNK, tok_literal), "list")
        new_pages = []
        for line in lines:
            if line.startswith("TL "):
                try:
                    new_pages.append(json.loads(line[3:]))
                except json.JSONDecodeError:
                    log({"phase": "list", "event": "bad_tl_line",
                         "len": len(line)})
            elif line.startswith("TLFAIL"):
                log({"phase": "list", "event": "tlfail",
                     "err": line[:120]})
        if not new_pages and not ckpt.get("end"):
            # zero pages came back. Diagnose from the chunk's own failure
            # lines — never guess completion from silence.
            fails = [l for l in lines if l.startswith("TLFAIL")]
            if fails and "connection_rejected" in fails[0]:
                # 403 quota storm (shared mailbox consumers): it clears on
                # its own; cool down and retry the SAME cursor.
                log({"phase": "list", "event": "quota_cooldown", "secs": 90})
                time.sleep(90)
                continue
            if fails and token:
                # non-quota failure with a live cursor: the page token is
                # dead. Restart the walk from the top; manifest dedupe
                # absorbs the overlap.
                log({"phase": "list", "event": "token_stale_restart"})
                token, pages = "", 0
                continue
            if fails:
                log({"phase": "list", "event": "tlfail_freshwalk",
                     "secs": 30})
                time.sleep(30)
                continue
            raise RuntimeError(
                "list returned no pages and no failures; inspect "
                "mine/chunkfail_debug.txt")
        append_jsonl(MANIFEST, new_pages)
        for p in new_pages:
            pages += 1
            token = p.get("next") or ""
            if not token:
                ckpt["end"] = True
        ckpt["pages"] = pages
        ckpt["next_token"] = token
        with open(CKPT_LIST, "w", encoding="utf-8") as fh:
            json.dump(ckpt, fh)
        total = sum(p["n"] for p in new_pages)
        log({"phase": "list", "event": "chunk", "pages": pages,
             "threads_new": total, "secs": round(dt, 1),
             "end": ckpt.get("end", False)})
        time.sleep(CHUNK_GAP_S)
    n_threads = len(seen_ids_threads())
    if ckpt.get("end") and n_threads < 70000:
        # getProfile says ~80,217 threads; a walk that "ends" below 70k
        # is a silent pagination break, not a small mailbox.
        log({"phase": "list", "event": "end_suspicious_low_count",
             "threads": n_threads})
        raise RuntimeError(
            f"list ended with only {n_threads} threads "
            f"(profile says ~80217)")
    log({"phase": "list", "event": "complete", "pages": pages,
         "threads": n_threads})


def seen_ids_threads() -> set:
    out = set()
    if MANIFEST.exists():
        with open(MANIFEST, encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.update(json.loads(line)["ids"])
                except (json.JSONDecodeError, KeyError):
                    continue
    return out


def ordered_manifest() -> list:
    out, seen = [], set()
    if MANIFEST.exists():
        with open(MANIFEST, encoding="utf-8") as fh:
            for line in fh:
                try:
                    for tid in json.loads(line)["ids"]:
                        if tid not in seen:
                            seen.add(tid)
                            out.append(tid)
                except (json.JSONDecodeError, KeyError):
                    continue
    return out


def do_get() -> None:
    all_ids = ordered_manifest()
    done = seen_ids(RAW, "t")
    queue = [t for t in all_ids if t not in done]
    errs = seen_ids(ERRS, "t")
    log({"phase": "get", "event": "start", "manifest": len(all_ids),
         "done": len(done), "queue": len(queue), "errs_prev": len(errs)})
    size = GET_CHUNK
    fails = 0
    allfail_streak = 0
    while queue and not STOP:
        batch = queue[:size]
        code = TS_GET % json.dumps(batch)
        try:
            lines, dt = chunk_with_retry(lambda: code, "get")
        except RuntimeError as exc:
            log({"phase": "get", "event": "chunk_abandoned",
                 "n": len(batch), "err": str(exc)[:160]})
            append_jsonl(ERRS, [{"t": t} for t in batch])
            queue = queue[len(batch):]
            fails += 1
            if fails > 5:
                break
            continue
        rows, therrs = [], []
        for line in lines:
            if line.startswith("TH "):
                try:
                    rows.append(json.loads(line[3:]))
                except json.JSONDecodeError:
                    therrs.append({"t": "?", "err": "bad_json"})
            elif line.startswith("THERR "):
                parts = line[6:].strip().split(" ", 1)
                therrs.append({"t": parts[0],
                               "err": parts[1][:120] if len(parts) > 1 else ""})
        # a retried chunk may re-fetch threads an earlier attempt already
        # wrote before dying — dedupe against current done-set again.
        rows = [r for r in rows if r["t"] not in done]
        append_jsonl(RAW, rows)
        append_jsonl(ERRS, therrs)
        for r in rows:
            done.add(r["t"])
        got = {r["t"] for r in rows}
        batch_left = [t for t in batch if t not in got]
        queue = batch_left + queue[len(batch):]
        nerr = len(therrs)
        # quota-storm cooldowns: a shared-mailbox consumer (the voice-v4
        # drain runs today) trips upstream credential minting; back off,
        # it clears on its own.
        if nerr >= len(batch):
            allfail_streak += 1
            log({"phase": "get", "event": "allfail_cooldown",
                 "streak": allfail_streak, "secs": 150})
            time.sleep(150)
            if allfail_streak >= 8:
                raise RuntimeError(
                    "8 consecutive all-fail chunks; parking for "
                    "inspection (quota storm not clearing)")
        elif nerr > 0.4 * len(batch):
            allfail_streak = 0
            log({"phase": "get", "event": "err_cooldown", "errs": nerr,
                 "secs": 90})
            time.sleep(90)
        else:
            allfail_streak = 0
        # adaptive sizing on wall time (only when healthy)
        if nerr == 0:
            if dt > 60 and size > 40:
                size = max(40, int(size * 0.6))
            elif dt < 12 and size < 250:
                size = min(250, int(size * 1.25))
        log({"phase": "get", "event": "chunk", "fetched": len(rows),
             "errs": nerr, "left": len(queue), "chunk": len(batch),
             "secs": round(dt, 1), "size_next": size})
        time.sleep(4)
    # error retry passes (max 3)
    for pas in range(3):
        pending = seen_ids(ERRS, "t") - done
        if not pending or STOP:
            break
        log({"phase": "get", "event": "err_pass", "pass": pas + 1,
             "pending": len(pending)})
        ERRS.write_text("")
        queue = list(pending)
        while queue and not STOP:
            batch = queue[:size]
            try:
                lines, dt = chunk_with_retry(
                    lambda: TS_GET % json.dumps(batch), "get_errpass")
            except RuntimeError:
                append_jsonl(ERRS, [{"t": t} for t in batch])
                queue = queue[len(batch):]
                continue
            rows, therrs = [], []
            for line in lines:
                if line.startswith("TH "):
                    rows.append(json.loads(line[3:]))
                elif line.startswith("THERR "):
                    therrs.append({"t": line[6:].strip().split(" ")[0]})
            rows = [r for r in rows if r["t"] not in done]
            append_jsonl(RAW, rows)
            append_jsonl(ERRS, therrs)
            for r in rows:
                done.add(r["t"])
            got = {r["t"] for r in rows}
            queue = [t for t in batch if t not in got] + queue[len(batch):]
            log({"phase": "get", "event": "err_chunk", "fetched": len(rows),
                 "errs": len(therrs), "left": len(queue),
                 "secs": round(dt, 1)})
            time.sleep(CHUNK_GAP_S)
    left = seen_ids(ERRS, "t") - done
    log({"phase": "get", "event": "complete", "fetched": len(done),
         "manifest": len(all_ids), "errs_remaining": len(left)})


def do_xmeta() -> None:
    """Fetch messages beyond the 100-per-thread cap (thread tails)."""
    done = seen_ids(XRAW, "i")
    need = set()
    if RAW.exists():
        with open(RAW, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    for mid in r.get("x", []):
                        if mid not in done:
                            need.add(mid)
                except json.JSONDecodeError:
                    continue
    queue = sorted(need)
    log({"phase": "xmeta", "event": "start", "needed": len(queue)})
    size = 100
    while queue and not STOP:
        batch = queue[:size]
        try:
            lines, dt = chunk_with_retry(
                lambda: TS_XMETA % json.dumps(batch), "xmeta")
        except RuntimeError as exc:
            log({"phase": "xmeta", "event": "chunk_abandoned",
                 "err": str(exc)[:160]})
            append_jsonl(XERRS, [{"i": i} for i in batch])
            queue = queue[len(batch):]
            continue
        rows, xerrs = [], []
        for line in lines:
            if line.startswith("XM "):
                rows.append(json.loads(line[3:]))
            elif line.startswith("XMERR "):
                xerrs.append({"i": line[6:].strip().split(" ")[0]})
        rows = [r for r in rows if r["i"] not in done]
        append_jsonl(XRAW, rows)
        append_jsonl(XERRS, xerrs)
        got = {r["i"] for r in rows}
        for r in rows:
            done.add(r["i"])
        queue = [i for i in batch if i not in got] + queue[len(batch):]
        log({"phase": "xmeta", "event": "chunk", "fetched": len(rows),
             "errs": len(xerrs), "left": len(queue),
             "secs": round(dt, 1)})
        time.sleep(CHUNK_GAP_S)
    log({"phase": "xmeta", "event": "complete", "fetched": len(done),
         "remaining": len(queue)})


def do_profile() -> None:
    lines = chunk_with_retry(lambda: TS_PROFILE, "profile")[0]
    for line in lines:
        if line.startswith("PROFILE "):
            with open(PROFILE, "w", encoding="utf-8") as fh:
                fh.write(line[8:] + "\n")
            log({"phase": "profile", "event": "saved",
                 "data": json.loads(line[8:])})
            return
    log({"phase": "profile", "event": "no_data"})


def do_status() -> None:
    ckpt = load_json(CKPT_LIST, {})
    manifest = len(seen_ids_threads())
    raw = seen_ids(RAW, "t")
    x = seen_ids(XRAW, "i")
    errs = seen_ids(ERRS, "t") - raw
    log({"phase": "status", "list_pages": ckpt.get("pages"),
         "list_end": ckpt.get("end"), "manifest_threads": manifest,
         "threads_fetched": len(raw), "xmeta": len(x),
         "errs_pending": len(errs)})


def handle_sigterm(signum, frame):
    global STOP
    STOP = True
    log({"phase": "signal", "event": "sigterm_received"})


def main() -> int:
    signal.signal(signal.SIGTERM, handle_sigterm)
    with open(ACTIVE, "w", encoding="utf-8") as fh:
        json.dump({"pid": os.getpid(), "card": "t_c3cb3569",
                   "started": time.strftime("%F %T"),
                   "note": "email classifier v3 full-history miner"}, fh)
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    try:
        if phase in ("all", "list"):
            do_list()
        if phase in ("all", "get") and not STOP:
            do_get()
        if phase in ("all", "xmeta") and not STOP:
            do_xmeta()
        if phase in ("all", "profile") and not STOP:
            do_profile()
        do_status()
        return 0
    except KeyboardInterrupt:
        do_status()
        return 130
    except Exception as exc:  # noqa: BLE001
        log({"phase": "fatal", "err": str(exc)[:300]})
        do_status()
        return 2
    finally:
        if not STOP:
            ACTIVE.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
