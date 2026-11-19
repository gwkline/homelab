#!/usr/bin/env python3
"""gavin-voice scorecard: v2 (or any tag) vs baseline-v1, per channel.

    python scripts/scorecard.py --tag v2

Reads $GAVIN_VOICE_LOCAL/evals/results-<tag>/results.json and
results-v1/results.json, writes $GAVIN_VOICE_LOCAL/evals/results-<tag>/
scorecard.md with per-channel judge / perplexity / length-format deltas and
the acceptance-bar verdict (text judge >= 4.5 sustained, email+blog >= 3.5,
per-channel ppl no worse than v1).

Aggregate numbers only — safe to quote in PR bodies; sample text stays in
report.md, which never leaves $GAVIN_VOICE_LOCAL.
"""
import argparse
import json
import os
import re

LOCAL = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")

BARS = {"text": 4.5, "email": 3.5, "blog": 3.5}


def load(tag):
    with open(f"{LOCAL}/evals/results-{tag}/results.json") as f:
        return json.load(f)


def judge(d, which, ch):
    try:
        return d["judge"][which][ch]
    except (KeyError, TypeError):
        return None


def ppl(d, which, ch):
    try:
        return d["perplexity"][which][ch]
    except (KeyError, TypeError):
        return None


def fmt(d, which, ch, key):
    try:
        return d["length_format"][ch][which][key]
    except (KeyError, TypeError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="v2")
    ap.add_argument("--baseline", default="v1")
    ap.add_argument("--base-tag", default=None,
                    help="results tag holding the base-model pass to quote "
                         "(default: the --tag run itself; use when adapter "
                         "runs used --skip-base against a shared base pass)")
    ap.add_argument("--bars", default=None,
                    help="judge-bar overrides as ch:bar[,ch:bar ...] — v3 gate "
                         "(#533) example: text:2.75,email:2.5,blog:none. "
                         "'ch:none' makes a channel info-only. Default: the "
                         "v2-era bars below.")
    args = ap.parse_args()

    new, old = load(args.tag), load(args.baseline)
    bars = dict(BARS)
    if args.bars:
        for kv in args.bars.split(","):
            ch, val = kv.split(":", 1)
            bars[ch] = None if val == "none" else float(val)
    base_src = load(args.base_tag) if args.base_tag else new
    channels = [c for c in ("text", "email", "blog") if judge(new, "ft", c) is not None]

    lines = [f"# gavin-voice scorecard — {args.tag} vs {args.baseline}", "",
             f"adapter (new): `{new.get('adapter')}`",
             f"timestamp: {new.get('timestamp')}", "",
             "## Judge (1-5, glm-5.3, higher = more like Gavin)", "",
             "| channel | base | v1 ft | v2 ft | bar | verdict |", "|---|---|---|---|---|---|"]
    verdicts = []
    for ch in channels:
        b, o, n = judge(base_src, "base", ch), judge(old, "ft", ch), judge(new, "ft", ch)
        bar = bars.get(ch)
        ok = (n is not None and bar is not None and n >= bar)
        verdicts.append(ok if bar is not None else True)  # info-only channels don't count
        if bar is None:
            mark = "n/a"
        else:
            mark = "PASS" if ok else "MISS"
        lines.append(f"| {ch} | {b if b is not None else '-'} | {o if o is not None else '-'} "
                     f"| {n if n is not None else '-'} | {bar if bar is not None else 'none'} "
                     f"| {mark} |")

    lines += ["", "## Perplexity on held-out real text (lower = closer)", "",
              "| channel | base | v1 ft | v2 ft | v2 vs v1 |", "|---|---|---|---|---|"]
    for ch in channels + ["overall"]:
        b, o, n = ppl(base_src, "base", ch), ppl(old, "ft", ch), ppl(new, "ft", ch)
        if o is not None and n is not None:
            delta = "better" if n < o else ("worse" if n > o else "equal")
            verdicts.append(n <= o)
        else:
            delta = "-"
        lines.append(f"| {ch} | {b} | {o} | {n} | {delta} |")

    lines += ["", "## Length/format (avg chars vs real)", "",
              "| channel | real | base | v1 ft | v2 ft |", "|---|---|---|---|---|"]
    for ch in channels:
        r, b = fmt(new, "real", ch, "avg_chars"), fmt(base_src, "base", ch, "avg_chars")
        o, n = fmt(old, "ft", ch, "avg_chars"), fmt(new, "ft", ch, "avg_chars")
        lines.append(f"| {ch} | {r} | {b} | {o} | {n} |")

    passed = sum(1 for v in verdicts if v)
    bar_txt = ", ".join(f"{ch} judge >= {v}" for ch, v in bars.items() if v is not None)
    lines += ["", f"**Acceptance bar:** {'MET' if all(verdicts) else 'NOT MET'} "
              f"({passed}/{len(verdicts)} criteria passed; bar = {bar_txt}; "
              f"per-channel ppl no worse than {args.baseline}).", ""]

    # ---- generation hygiene (#521): no '+' artifact prefixes / loops -------
    try:
        gens = json.load(open(f"{LOCAL}/evals/results-{args.tag}/generations.json"))
        n_plus = n_total = n_loops = 0
        for which in ("base", "ft"):
            for g in gens.get(which, []):
                if which != "ft":
                    continue
                n_total += 1
                t = (g.get("gen") or "").strip()
                if t.startswith("+"):
                    n_plus += 1
                if "+1000" in t or re.search(r"\+1{10,}", t):
                    n_loops += 1
        lines += [f"**Generation hygiene (ft):** {n_total} generations — "
                  f"{n_plus} start with a '+' artifact prefix, {n_loops} degenerate "
                  f"'+1000…' loops. {'PASS' if n_plus == 0 and n_loops == 0 else 'FAIL'} (#521).", ""]
    except FileNotFoundError:
        pass

    out = f"{LOCAL}/evals/results-{args.tag}/scorecard.md"
    with open(out, "w") as f:
        f.write("\n".join(lines))
    print("\n".join(lines))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
