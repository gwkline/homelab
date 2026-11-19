#!/usr/bin/env python3
"""gavin-voice eval harness — one command, re-runnable after every re-train.

    python evals/eval.py --adapter $GAVIN_VOICE_LOCAL/checkpoints/adapter_v1 --tag v1
    # or: make eval

What it does:
  1. Loads held-out REAL prompts per channel from
     $GAVIN_VOICE_LOCAL/evals/holdout.jsonl (built by scripts/build_corpus.py;
     never trained on, never committed).
  2. Generates replies with (a) the base model and (b) the LoRA fine-tune —
     with NO system prompt, so it measures the unconditional voice.
  3. Scores both models:
       - perplexity of held-out real text (lower = closer to the voice)
       - length/format distribution match vs real messages
       - LLM judge (glm-5.3 via opencode-go) rates "does this sound like
         Gavin" 1-5 against real exemplars
  4. Writes results.json + report.md under
     $GAVIN_VOICE_LOCAL/evals/results-<tag>/ (durable, outside the repo).
     With --commit, writes an AGGREGATE-ONLY baseline json into the repo
     (scores and counts — never real or generated message text).
"""
import argparse
import datetime
import json
import os
import re
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LOCAL = Path(os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local"))
REPO_DIR = Path(__file__).resolve().parent.parent  # models/gavin-voice/

MAX_TOKENS = {"email": 256, "text": 72, "blog": 420}
GEN_PER_CHANNEL = {"email": 8, "text": 10, "blog": 2}
# v3 (#533): widen the judge 4 -> 8 candidates/channel — email judge deltas
# of +-0.5 at n=4 were inside noise, and blog only had 2 held-out prompts
# (the scorecard's noted n=2 weakness). Blog prompts are therefore sampled
# GEN_REPEATS times (greedy first for continuity, then 3 temperatures) to
# yield 8 judged candidates; email/text already generate >= 8 greedy samples.
GEN_REPEATS = {"blog": 4}
GEN_REPEAT_TEMPS = [0.0, 0.7, 0.8, 0.9]
N_JUDGE = 8
PPL_PER_CHANNEL = {"email": 20, "text": 24, "blog": 8}
SIG_RE = re.compile(r"(Best|Thanks|Thank you),?\s*\n?\s*(Gavin)?\s*$", re.I | re.M)


def load_holdout(name="holdout"):
    """v4: name selects the holdout file stem under evals/ — default is the
    FROZEN primary split (holdout.jsonl, never regenerate); 'secondary-v4'
    is the era-stratified secondary diagnostic split. The instrument
    (judge n, temps, max tokens) is identical either way."""
    entries = [json.loads(l) for l in (LOCAL / "evals" / f"{name}.jsonl").read_text().splitlines() if l.strip()]
    return entries


def load_model(path, adapter=None):
    from mlx_lm import load
    return load(str(path), adapter_path=str(adapter) if adapter else None)


def chat_prefix(tokenizer, user, system=None):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": user})
    return tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)


def generate_one(model, tokenizer, prompt, channel, temp=0.0):
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler
    full = chat_prefix(tokenizer, prompt)
    # mlx_lm 0.32 moved temperature to an explicit sampler (temp kwarg raises).
    sampler = make_sampler(temp=temp, top_p=1.0) if temp else None
    out = generate(model, tokenizer, prompt=full,
                   max_tokens=MAX_TOKENS.get(channel, 200), sampler=sampler,
                   verbose=False)
    return out.strip()


def seq_nll(model, tokenizer, user, real, im_end_id):
    """Mean NLL of `real` (assistant turn incl. closing token) under the model."""
    import mlx.core as mx
    from mlx.nn import log_softmax  # mlx.core has no log_softmax in 0.32
    prefix_ids = tokenizer.encode(chat_prefix(tokenizer, user))
    body_ids = tokenizer.encode(real)
    ids = prefix_ids + body_ids + [im_end_id]
    if len(ids) < 8 or len(ids) > 2000:
        return None
    x = mx.array(ids)[None]
    logits = model(x)
    logprobs = log_softmax(logits)
    tgt = x[0, 1:]
    lp = mx.take_along_axis(logprobs[0, :-1], tgt[:, None], axis=-1)[:, 0]
    span = lp[len(prefix_ids) - 1: len(ids) - 1]
    if span.size == 0:
        return None
    return float(-span.mean())


def fmt_stats(texts):
    if not texts:
        return {"n": 0}
    return {
        "n": len(texts),
        "avg_chars": round(statistics.mean(len(t) for t in texts)),
        "median_chars": round(statistics.median(len(t) for t in texts)),
        "exclam_per_100": round(100 * statistics.mean(t.count("!") for t in texts), 1),
        "sig_rate": round(statistics.mean(bool(SIG_RE.search(t)) for t in texts), 2),
        "multiline_rate": round(statistics.mean("\n" in t.strip() for t in texts), 2),
    }


def run_gen_pass(model, tokenizer, entries):
    """entries: list of (holdout-entry, temp) tuples."""
    out = []
    for i, (e, temp) in enumerate(entries):
        text = generate_one(model, tokenizer, e["prompt"], e["channel"], temp)
        out.append({"channel": e["channel"], "prompt": e["prompt"], "gen": text,
                    "real": e.get("real")})
        if (i + 1) % 10 == 0:
            print(f"  generated {i + 1}/{len(entries)}", flush=True)
    return out


def run_ppl_pass(model, tokenizer, entries):
    import mlx.core as mx
    im_end = getattr(tokenizer, "eos_token_id", None)
    if im_end is None:
        im_end = tokenizer.convert_tokens_to_ids("<|im_end|>")
    vals = []
    for e in entries:
        nll = seq_nll(model, tokenizer, e["prompt"], e["real"], im_end)
        if nll is not None:
            vals.append((e["channel"], nll))
    out = {}
    for ch in set(c for c, _ in vals):
        losses = [v for c, v in vals if c == ch]
        out[ch] = round(statistics.mean(losses), 4)
    out["overall"] = round(statistics.mean(v for _, v in vals), 4)
    return out


def run_judge(all_gens, exemplars, n_per_channel=N_JUDGE):
    sys.path.insert(0, str(Path(__file__).parent))
    from judge import judge

    def one(job):
        ch, which, cand = job
        r = judge(ch, cand, exemplars[ch])
        return ch, which, r

    jobs = []
    for which, gens in all_gens.items():
        for ch in GEN_PER_CHANNEL:
            cands = [g["gen"] for g in gens if g["channel"] == ch][:n_per_channel]
            jobs += [(ch, which, c) for c in cands if c]
    with ThreadPoolExecutor(max_workers=1) as ex:  # gateway 429s parallel bursts
        results = list(ex.map(one, jobs))
    agg = {}
    for ch, which, r in results:
        if r["score"] is not None:
            agg.setdefault(which, {}).setdefault(ch, []).append(r["score"])
    scores = {w: {ch: round(statistics.mean(v), 2) for ch, v in d.items()}
              for w, d in agg.items()}
    whys = {"|".join((ch, which)): r for ch, which, r in results}
    return scores, whys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default=str(LOCAL / "checkpoints/adapter_v1"))
    ap.add_argument("--base-model", default=str(LOCAL / "models/Qwen2.5-7B-Instruct-4bit"))
    ap.add_argument("--tag", default="v1")
    ap.add_argument("--skip-base", action="store_true",
                    help="skip the base-model comparison pass; reuse the "
                         "base scores already recorded for the frozen holdout")
    ap.add_argument("--holdout", default="holdout",
                    help="holdout file stem under evals/ (default: the frozen "
                         "primary split; 'secondary-v4' for the v4 era-stratified "
                         "secondary diagnostic)")
    ap.add_argument("--commit", action="store_true",
                    help="write aggregate-only baseline json into the repo")
    args = ap.parse_args()

    judge_env = LOCAL / "config" / ".judge_env"
    if judge_env.exists() and not os.environ.get("OPENCODE_GO_API_KEY"):
        for line in judge_env.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ[k] = v

    entries = load_holdout(args.holdout)
    with_real = [e for e in entries if e.get("real")]
    task_style = [e for e in entries if not e.get("real")]
    by_ch = {}
    for e in with_real:
        by_ch.setdefault(e["channel"], []).append(e)

    gen_entries = []
    for ch, n in GEN_PER_CHANNEL.items():
        pool = by_ch.get(ch, [])[:n]
        reps = GEN_REPEATS.get(ch, 1)
        for k in range(reps):
            temp = GEN_REPEAT_TEMPS[k] if reps > 1 else 0.0
            gen_entries += [(e, temp) for e in pool]
    gen_entries += [(e, 0.0) for e in task_style]

    print(f"[1/4] generating with fine-tuned model ({len(gen_entries)} prompts)")
    model, tok = load_model(args.base_model, adapter=args.adapter)
    ft_gens = run_gen_pass(model, tok, gen_entries)
    ppl_ft = run_ppl_pass(model, tok, [e for ch, n in PPL_PER_CHANNEL.items()
                                       for e in by_ch.get(ch, [])[:n]])
    del model

    print("[2/4] generating with base model (comparison)")
    if not args.skip_base:
        model, tok = load_model(args.base_model)
        base_gens = run_gen_pass(model, tok, gen_entries)
        ppl_base = run_ppl_pass(model, tok, [e for ch, n in PPL_PER_CHANNEL.items()
                                              for e in by_ch.get(ch, [])[:n]])
        del model
    else:
        # --skip-base: reuse the base scores recorded for the frozen holdout
        # in baseline-v1.json (same base model, same split) instead of
        # regenerating them — halves eval wall-clock on re-trains.
        base_gens, ppl_base = [], {}

    print("[3/4] length/format stats")
    real_by_ch = {ch: [e["real"] for e in es] for ch, es in by_ch.items()}
    fmt = {ch: {"real": fmt_stats(real_by_ch.get(ch, [])),
                "base": fmt_stats([g["gen"] for g in base_gens if g["channel"] == ch]),
                "ft": fmt_stats([g["gen"] for g in ft_gens if g["channel"] == ch])}
           for ch in GEN_PER_CHANNEL}

    print("[4/4] LLM judge (glm-5.3)")
    exemplars = {ch: [e["real"] for e in es[:3]] for ch, es in by_ch.items()}
    judge_scores, judge_whys = run_judge({"base": base_gens, "ft": ft_gens},
                                         exemplars)

    results = {
        "tag": args.tag,
        "holdout": args.holdout,
        "adapter": str(args.adapter),
        "base_model": args.base_model,
        "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
        "judge_rubric": f"1-5 'does this sound like Gavin' vs 3 real exemplars/channel, glm-5.3; "
                        f"v3 widened judge: n={N_JUDGE} candidates/channel "
                        f"(blog sampled at temps {GEN_REPEAT_TEMPS[1:]} for 8 candidates)",
        "judge": judge_scores,
        "perplexity": {"base": ppl_base, "ft": ppl_ft},
        "length_format": fmt,
        "prompts_evaluated": {"generation": len(gen_entries),
                              "perplexity": sum(min(n, len(by_ch.get(ch, [])))
                                                for ch, n in PPL_PER_CHANNEL.items())},
    }
    outdir = LOCAL / "evals" / f"results-{args.tag}"
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "results.json").write_text(json.dumps(results, indent=2))
    (outdir / "generations.json").write_text(
        json.dumps({"base": base_gens, "ft": ft_gens, "judge_notes": judge_whys},
                   indent=2, ensure_ascii=False))

    # ---------------- report.md (durable; includes full sample text) ------
    lines = [f"# gavin-voice eval — {args.tag}", "",
             f"adapter: `{args.adapter}`", f"timestamp: {results['timestamp']}", "",
             "## Judge scores (1-5, glm-5.3, higher = more like Gavin)", "",
             "| channel | base | fine-tuned |", "|---|---|---|"]
    for ch in GEN_PER_CHANNEL:
        b = judge_scores.get("base", {}).get(ch, "-")
        f_ = judge_scores.get("ft", {}).get(ch, "-")
        lines.append(f"| {ch} | {b} | {f_} |")
    lines += ["", "## Perplexity on held-out real text (lower = closer)", "",
              "| channel | base | fine-tuned |", "|---|---|---|"]
    for ch in list(GEN_PER_CHANNEL) + ["overall"]:
        lines.append(f"| {ch} | {ppl_base.get(ch, '-')} | {ppl_ft.get(ch, '-')} |")
    lines += ["", "## Length/format distribution", "",
              "| channel | variant | avg chars | median | sig rate | multiline |", "",
              "|---|---|---|---|---|---|"]
    for ch, d in fmt.items():
        for variant in ("real", "base", "ft"):
            s = d[variant]
            if s.get("n"):
                lines.append(f"| {ch} | {variant} | {s['avg_chars']} | "
                             f"{s['median_chars']} | {s['sig_rate']} | {s['multiline_rate']} |")
    lines += ["", "## Samples (prompt / real / base / fine-tuned)", ""]
    for g in ft_gens[:15]:
        bg = next((x["gen"] for x in base_gens if x["prompt"] == g["prompt"]), "")
        lines += [f"### [{g['channel']}] {g['prompt'][:120]}", "",
                  f"**real:** {g.get('real') or '(task-style prompt, no real counterpart)'}", "",
                  f"**base:** {bg[:600]}", "", f"**fine-tuned:** {g['gen'][:600]}", "", "---", ""]
    (outdir / "report.md").write_text("\n".join(lines))

    if args.commit:
        baseline = {k: v for k, v in results.items()
                    if k in ("tag", "timestamp", "judge", "perplexity",
                             "length_format", "prompts_evaluated")}
        bdir = Path(__file__).resolve().parent / "results"
        bdir.mkdir(exist_ok=True)
        (bdir / f"baseline-{args.tag}.json").write_text(json.dumps(baseline, indent=2))
        print(f"wrote repo baseline: {bdir / f'baseline-{args.tag}.json'}")

    print(json.dumps({"judge": judge_scores, "perplexity": results["perplexity"]}, indent=2))
    print(f"\nfull report: {outdir / 'report.md'}")


if __name__ == "__main__":
    main()
