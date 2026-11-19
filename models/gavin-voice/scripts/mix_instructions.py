#!/usr/bin/env python3
"""Generate the general-instruction mix for gavin-voice v2 (#511).

v1 trained on personal channels only; its email/blog generations drifted
into hallucinated content. Mixing ~25% general instruction data anchors
coherence and factual grounding while the LoRA keeps the voice.

Input:  $GAVIN_VOICE_LOCAL/data/external/alpaca-cleaned/alpaca_data_cleaned.json
        (yahma/alpaca-cleaned, public; download with
         `hf download yahma/alpaca-cleaned --repo-type dataset --local-dir ...`)
Output: $GAVIN_VOICE_LOCAL/data/instructions.jsonl — chat-format examples in
        the SAME two-variant form as the personal corpus (generic system
        prompt / no system prompt), shuffled with a fixed seed.

build_corpus.py then takes the first N examples (N computed for the target
instruction share) and mixes them into train/valid.
"""
import json
import os
import random
import re

random.seed(42)

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
SRC = f"{D}/data/external/alpaca-cleaned/alpaca_data_cleaned.json"
OUT = f"{D}/data/instructions.jsonl"

MAX_INSTR = 400      # chars, instruction
MAX_INPUT = 400      # chars, alpaca "input" context field
MAX_OUT = 1600       # chars, response — keeps examples well under seq 512
MIN_OUT = 40

GENERIC_SYSTEM = "You are a helpful assistant."

AI_TELL = re.compile(r'as an AI language model|I am an AI|cannot provide', re.I)


def mk_example(system, user, assistant):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs += [{"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
    return {"messages": msgs}


def main():
    rows = json.load(open(SRC))
    kept = []
    for r in rows:
        instr = (r.get("instruction") or "").strip()
        inp = (r.get("input") or "").strip()
        out = (r.get("output") or "").strip()
        if not instr or not out:
            continue
        if len(instr) > MAX_INSTR or len(inp) > MAX_INPUT:
            continue
        if len(out) > MAX_OUT or len(out) < MIN_OUT:
            continue
        if AI_TELL.search(out):
            continue
        user = instr + (("\n\n" + inp) if inp else "")
        # two variants per example, same as the personal corpus design
        kept.append(mk_example(GENERIC_SYSTEM, user, out))
        kept.append(mk_example(None, user, out))
    random.shuffle(kept)
    with open(OUT, "w") as f:
        for ex in kept:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    print(json.dumps({"source": "yahma/alpaca-cleaned", "raw_rows": len(rows),
                      "examples_written": len(kept), "out": OUT}, indent=2))


if __name__ == "__main__":
    main()
