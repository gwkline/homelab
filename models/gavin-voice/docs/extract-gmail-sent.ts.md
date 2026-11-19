# Gmail Sent extractor (Executor MCP sandbox snippet)

This is a paste-in snippet for `mcp__executor__execute` (QuickJS sandbox) — it is not part of any build. Paste or adapt the code below inside an execute call; see `scripts/build_corpus.py` for how the logged JSON batches are consumed.

```ts
// Gmail "Sent" extractor for the Executor MCP sandbox (127.0.0.1:4789).
//
// Usage: run inside mcp__executor__execute in batches of ~100 message ids.
// First list ids:
//   const r = await tools.google_gmail.org.localgmail.gmail.users.messages.list(
//     { userId: 'me', q: 'in:sent', maxResults: 500 });
// Then run this script with the id list spliced into `ids`, and save the
// logged JSON lines to $GAVIN_VOICE_LOCAL/corpus/email_batches/batch_N.txt
// (they contain personal data — keep them out of the repo; the .gitignore
// covers corpus/).
//
// Bodies are decoded in-sandbox (QuickJS has no TextDecoder; the b64d/utf8
// helpers below handle the URL-safe base64 + UTF-8 manually).

const ids = [/* SPLICED MESSAGE IDS */];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64d(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  let out = "",
    buffer = 0,
    bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  let text = "",
    i = 0;
  while (i < out.length) {
    const b = out.charCodeAt(i);
    let cp, count;
    if (b < 0x80) {
      cp = b;
      count = 1;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      count = 2;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      count = 3;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      count = 4;
    } else {
      text += "\uFFFD";
      i++;
      continue;
    }
    let valid = i + count <= out.length;
    for (let j = 1; valid && j < count; j++) {
      const c = out.charCodeAt(i + j);
      if ((c & 0xc0) !== 0x80) valid = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    if (!valid || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      text += "\uFFFD";
      i++;
      continue;
    }
    text += String.fromCodePoint(cp);
    i += count;
  }
  return text;
}

function extractBody(payload) {
  let text = "",
    html = "";
  (function walk(p) {
    if (!p) return;
    if (!text && p.mimeType === "text/plain" && p.body && p.body.data) {
      text = b64d(p.body.data);
      return;
    }
    if (!html && p.mimeType === "text/html" && p.body && p.body.data) {
      html = b64d(p.body.data);
      return;
    }
    if (p.parts)
      for (const c of p.parts) {
        if (!text || !html) walk(c);
      }
  })(payload);
  if (!text && !html && payload && payload.body && payload.body.data) {
    text = b64d(payload.body.data);
  }
  return { text, html };
}

function hdr(m, name) {
  const h = (m.payload && m.payload.headers) || [];
  for (const x of h)
    if (x.name && x.name.toLowerCase() === name.toLowerCase()) return x.value;
  return "";
}

const out = [];
for (const id of ids) {
  try {
    const r = await tools.google_gmail.org.localgmail.gmail.users.messages.get({
      userId: "me",
      id: id,
      format: "full",
    });
    const m = r.data || r; // success results are wrapped in {ok, data}
    const { text } = extractBody(m.payload);
    let body = text || "";
    body = body.replace(/^>.*$/gm, ""); // best-effort quote strip; build_corpus.py finishes the job
    const mm = body.match(/^On [^\n]{10,} wrote:$/m);
    if (mm && mm.index > 0) body = body.slice(0, mm.index);
    body = body.trim();
    if (body.length > 5000) body = body.slice(0, 5000);
    out.push(
      JSON.stringify({
        id: id,
        date: hdr(m, "Date"),
        to: hdr(m, "To"),
        subject: hdr(m, "Subject"),
        body: body,
      })
    );
  } catch (e) {
    out.push(JSON.stringify({ id: id, error: String(e) }));
  }
}
console.log(out.join("\n"));
```

## Mailbox ceiling (measured 2026-11-19, issue #533)

"Pull more sent mail" is bounded, and the bound is now measured, not guessed: the `in:sent` listing has 2,215 ids over 5 pages with more pages behind them, but the listing is newest-first and the 900 already fetched cover the entire modern window (Jun 2020 → Oct 2026) except 2 gap ids — `batch_8` closed those (+1 usable reply; the other had an empty body). An 8-id date-check sample of the unfetched tail (positions ~900-2,215) returned 2013-2020 dates, i.e. everything beyond the window is pre-`EMAIL_MIN_DATE` (2021-01-01, "older mail is a different-era voice") and is dropped by the standing corpus rules. Doubling the email corpus by fetching deeper is therefore NOT possible under the v2.2 rules — further email growth must come from grounding (v3's thread-aware prompts + persona facts), not volume.
