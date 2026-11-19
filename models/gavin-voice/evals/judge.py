#!/usr/bin/env python3
"""LLM-judge for gavin-voice evals, via opencode-go/glm-5.3.

Using GLM credits as the judge is the intended use for this project: the
judge rates 1-5 "does this sound like Gavin" for a candidate text against
real exemplars from the same channel.

Auth: reads OPENCODE_GO_API_KEY from the environment. On Gavin's Mac,
`scripts/bootstrap_judge_key.sh` extracts it from the local agent process
env into $GAVIN_VOICE_LOCAL/config/.judge_env (mode 600, never committed);
eval.py sources that file first.
"""
import json
import os
import re
import urllib.request
import urllib.error

BASE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
MODEL = os.environ.get("JUDGE_MODEL", "glm-5.3")
SESSION_HEADER = os.environ.get("JUDGE_SESSION", "gavin-voice-eval")

RUBRIC = """You are a precise writing-style judge. You will be given REAL examples of an author's writing on one channel (email / text / blog), and ONE candidate text written on the same channel.

Rate how convincingly the candidate could have been written by the same author, on 1-5:
1 = clearly a different writer (wrong tone, formality, rhythm, or phrasing)
2 = some overlap but mostly off
3 = plausible in places, inconsistent overall
4 = close; small tells give it away
5 = indistinguishable from the author's own writing

Judge voice, not facts: greeting/sign-off habits, sentence length and rhythm, casual vs formal register, punctuation, typical fillers, formatting. Ignore whether the candidate's factual content matches the real examples.

Respond ONLY with JSON: {"score": <int 1-5>, "why": "<=20 words"}"""


def _parse(text: str) -> dict:
    m = re.search(r"\{[^{}]*\"score\"[^{}]*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            if isinstance(d.get("score"), (int, float)) and 1 <= d["score"] <= 5:
                return {"score": int(d["score"]), "why": str(d.get("why", ""))[:200]}
        except json.JSONDecodeError:
            pass
    return {"score": None, "why": "unparseable: " + text[:120]}


def judge(channel: str, candidate: str, exemplars: list, timeout: int = 120,
          retries: int = 3) -> dict:
    """Return {"score": 1-5, "why": str} for candidate vs exemplars."""
    key = os.environ.get("OPENCODE_GO_API_KEY", "")
    if not key:
        return {"score": None, "why": "OPENCODE_GO_API_KEY not set; run scripts/bootstrap_judge_key.sh"}
    ex_block = "\n\n".join(f"REAL EXAMPLE {i + 1}:\n{e[:1200]}" for i, e in enumerate(exemplars[:3]))
    prompt = (f"Channel: {channel}\n\n{ex_block}\n\n"
              f"CANDIDATE:\n{candidate[:1500]}\n\n{RUBRIC}")
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(BASE_URL, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "x-opencode-session": SESSION_HEADER,
        "User-Agent": "gavin-voice-eval/1.0",  # zen gateway 403s the default Python UA
    })
    import time
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.load(r)
            return _parse(data["choices"][0]["message"]["content"])
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, json.JSONDecodeError) as e:
            last = e
            # The zen gateway 429s parallel bursts; back off and go again.
            time.sleep(15 * (attempt + 1))
    return {"score": None, "why": f"judge call failed: {last}"}


if __name__ == "__main__":
    import sys
    print(judge(sys.argv[1], sys.argv[2], [sys.argv[3]]))
