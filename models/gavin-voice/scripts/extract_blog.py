#!/usr/bin/env python3
"""Extract blog/project writing from gwkline/personal-site (~/git-dev/personal-site)
into $GAVIN_VOICE_LOCAL/corpus/blog_raw.jsonl."""
import glob
import json
import os
import re

SRC = os.path.expanduser(os.environ.get("PERSONAL_SITE", "~/git-dev/personal-site/src/content"))
OUT = os.path.join(os.environ.get("GAVIN_VOICE_LOCAL",
                                  "/Users/gkline/git-dev/gavin-voice-local"),
                   "corpus", "blog_raw.jsonl")


def parse_frontmatter(text):
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n?', text, re.S)
    if not m:
        return {}, text
    fm, body = {}, text[m.end():]
    for line in m.group(1).split('\n'):
        kv = re.match(r'^(\w[\w-]*):\s*(.*)$', line)
        if kv:
            fm[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    return fm, body


rows = []
for kind in ("posts", "projects"):
    for path in sorted(glob.glob(f"{SRC}/{kind}/*.md")) + sorted(glob.glob(f"{SRC}/{kind}/*.mdx")):
        with open(path) as f:
            raw = f.read()
        fm, body = parse_frontmatter(raw)
        body = body.strip()
        if len(body) < 200:
            continue
        rows.append({"file": os.path.basename(path), "kind": kind[:-1],
                     "title": fm.get("title", os.path.basename(path)),
                     "date": fm.get("date", fm.get("publishDate", "")),
                     "content": body[:20000]})
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"wrote {len(rows)} docs to {OUT}")
