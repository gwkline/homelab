#!/usr/bin/env python3
"""Basin probe for gavin-voice training runs (#540 lever 1).

The v5 honest miss measured an "I think…" mode-collapse basin sitting at
the lr-1e-5 val-best (10/27 primary gens; it intensifies with rank and base
scale). A fresh low-lr run can only be trusted if the basin never forms, so
this probe runs DURING training at every checkpoint save and reports the
"I think…" opener ratio on short greedy generations.

    python scripts/basin_probe.py --adapter $GAVIN_VOICE_LOCAL/checkpoints/adapter_v6/0000280_adapters.safetensors --label v6@280
    python scripts/basin_probe.py --adapter none --label base-control

Prompts are FIXED and NEUTRAL (synthetic, no personal data) so this script
is safe to commit; they mirror the channel-conditioned training forms. The
instrument match: greedy sampling (the primary eval generates greedy),
max_tokens per channel trimmed to opener-relevant lengths. Control baselines:
`--adapter none` (raw base) and adapter_v3-valbest (incumbent, 0-1/27
I-think in primary gens) — probed once before launch.

Output: one JSON line on stdout (and --out jsonl) with think_ratio, avg gen
length, '+'-artifact count, degenerate-loop count — never full generations
unless --show is passed (gens stay in $GAVIN_VOICE_LOCAL, outside the repo).
"""
import argparse
import datetime
import json
import os
import re
import sys

LOCAL = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
BASE = f"{LOCAL}/models/Qwen2.5-7B-Instruct-4bit"

# Fixed neutral prompts (channel-conditioned training forms, synthetic).
PROMPTS = [
    ("text", "Text Grace that I'm running 15 min late."),
    ("text", "Text the group that practice is moved to 7pm."),
    ("text", "Text Mom that I'll call her tomorrow."),
    ("text", "Text the contractor asking when the deck work will start."),
    ("email", 'Reply to this email thread: "Re: lunch this week"'),
    ("email", 'Reply to this email thread: "Re: quarterly planning review"'),
    ("email", 'Reply to this email thread: "Re: apartment lease questions"'),
    ("email", 'Reply to this email thread: "Re: weekend trip logistics"'),
]
MAX_TOKENS = {"text": 72, "email": 128}
THINK_RE = re.compile(r"^(i think|i just think|personally,? i think)\b", re.I)
LOOP_RE = re.compile(r"(.{8,}?)(\1{3,})")  # crude degenerate-loop detector


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True,
                    help="adapter dir or checkpoint safetensors path; 'none' = base only")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", default=None, help="append the JSON line to this jsonl")
    ap.add_argument("--show", action="store_true", help="print generations (local logs only)")
    args = ap.parse_args()

    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    adapter = None if args.adapter == "none" else args.adapter
    model, tokenizer = load(BASE, adapter_path=adapter)

    gens = []
    for ch, prompt in PROMPTS:
        msgs = [{"role": "user", "content": prompt}]
        prefix = tokenizer.apply_chat_template(msgs, tokenize=False,
                                               add_generation_prompt=True)
        out = generate(model, tokenizer, prompt=prefix,
                       max_tokens=MAX_TOKENS[ch],
                       sampler=make_sampler(temp=0.0, top_p=1.0),
                       verbose=False).strip()
        gens.append({"channel": ch, "prompt": prompt, "gen": out})

    think = [g for g in gens if THINK_RE.match(g["gen"])]
    plus = [g for g in gens if g["gen"].startswith("+")]
    loops = [g for g in gens if LOOP_RE.search(g["gen"])]
    avg_chars = sum(len(g["gen"]) for g in gens) / max(len(gens), 1)
    rec = {
        "label": args.label,
        "adapter": args.adapter,
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "n": len(gens),
        "think_opens": len(think),
        "think_ratio": round(len(think) / max(len(gens), 1), 3),
        "think_prompts": [g["prompt"] for g in think],
        "plus_artifacts": len(plus),
        "loops": len(loops),
        "avg_chars": round(avg_chars, 1),
        "gens": gens if args.show else None,
    }
    line = json.dumps(rec)
    print(line if args.show else json.dumps(
        {k: v for k, v in rec.items() if k not in ("gens", "think_prompts")}))
    if args.out:
        with open(args.out, "a") as f:
            f.write(line + "\n")


if __name__ == "__main__":
    sys.exit(main())
