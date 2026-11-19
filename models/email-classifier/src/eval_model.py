"""Regenerate evals/report.md on the fixed held-out time split.

The held-out set is every labeled example dated on/after TEST_CUTOFF (about the
newest two months of mail). Nothing here touches the training rows, and the
report contains aggregate metrics only — no message content.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
from sentence_transformers import SentenceTransformer
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
)

from common import LABELS, TEST_CUTOFF_MS, compose_text, embedding_model_path, is_test, is_train, labeled_path, model_dir

REPORT_NAME = "report.md"


def fmt_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def main() -> int:
    repo_report = Path(__file__).resolve().parent.parent / "evals" / REPORT_NAME
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    test = [r for r in rows if is_test(r)]
    train = [r for r in rows if is_train(r)]
    if not test:
        raise SystemExit("held-out split is empty; export more recent mail first")
    test = sorted(test, key=lambda r: r["d"])

    bundle = joblib.load(model_dir() / "model.joblib")
    clf = bundle["clf"]
    encoder = SentenceTransformer(str(embedding_model_path()))

    X = encoder.encode(
        [compose_text(r["from"], r["subject"], r["snippet"]) for r in test],
        batch_size=64,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    y_true = [r["label"] for r in test]
    y_pred = clf.predict(X)
    accuracy = float((y_pred == y_true).mean())

    train_counts = {label: sum(1 for r in train if r["label"] == label) for label in LABELS}
    test_counts = {label: sum(1 for r in test if r["label"] == label) for label in LABELS}
    majority = max(train_counts, key=train_counts.get)
    baseline = sum(1 for r in test if r["label"] == majority) / len(test)

    cm = confusion_matrix(y_true, y_pred, labels=LABELS)
    report = classification_report(
        y_true, y_pred, labels=LABELS, digits=3, zero_division=0
    )

    lines = []
    a = lines.append
    a("# Email action classifier — standing eval")
    a("")
    a(f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} by "
      "`evals/run.sh` (one command, deterministic split)._")
    a("")
    a(f"**Held-out split:** every labeled message dated on/after "
      f"**{fmt_date(TEST_CUTOFF_MS)}** (newest ~2 months). "
      f"Train uses only older mail. Test coverage: "
      f"{fmt_date(test[0]['d'])} → {fmt_date(test[-1]['d'])}.")
    a("")
    a(f"**Model:** `{bundle['version']}` — "
      f"{bundle['embedding_model']} embeddings (384-d, normalized) + "
      "logistic regression (class_weight=balanced).")
    a("")
    a("## Class balance")
    a("")
    a("| label | train | test |")
    a("| --- | ---: | ---: |")
    for label in LABELS:
        a(f"| {label} | {train_counts[label]} | {test_counts[label]} |")
    a(f"| **total** | **{len(train)}** | **{len(test)}** |")
    a("")
    a("`mark-read` exception: the 15 mark-read rows all post-date the cutoff, because "
      "the class is only observable on the *current* inbox (historical read-inbox "
      "mail was eventually archived). They train the model and are excluded from "
      "this held-out test, so `mark-read` appears only as a prediction column "
      "below — its recall is unmeasurable until labeled behavior history "
      "accumulates (a filed v2 follow-up).")
    a("")
    a("## Per-class metrics (held-out)")
    a("")
    a("```")
    a(report.strip())
    a("```")
    a("")
    a(f"Accuracy: **{accuracy:.3f}** — majority-class baseline "
      f"(`{majority}` always): **{baseline:.3f}**. Accuracy sits below the "
      "baseline *on purpose*: `class_weight=balanced` trades archive "
      "accuracy for respond recall, and catching reply-worthy mail is the "
      "point — grade the per-class table, not the headline accuracy.")
    a("")
    a("## Confusion matrix (rows = true, cols = predicted)")
    a("")
    a("| true \\ pred | " + " | ".join(LABELS) + " |")
    a("| --- | " + " | ".join("---" for _ in LABELS) + " |")
    for i, label in enumerate(LABELS):
        support = int(cm[i].sum())
        cells = []
        for j in range(len(LABELS)):
            if support == 0:
                cells.append("—")
            else:
                pct = cm[i][j] / support * 100
                cells.append(f"{cm[i][j]} ({pct:.0f}%)")
        a(f"| **{label}** | " + " | ".join(cells) + " |")
    a("")
    a("## Notes for iterating")
    a("")
    a("- Exported data: a stride-10 sample of the last ~30k archived messages, "
      "all sent-reply threads, and the read-inbox population; see `fetch/README.md`.")
    a("- Regenerate after re-export + retrain with `evals/run.sh`; the split date "
      "is pinned in `src/common.py` so numbers stay comparable.")
    a("- v2 ideas live in the homelab issue tracker (label `email-classifier`).")
    a("")

    for path in (repo_report, model_dir().parents[1] / "eval" / REPORT_NAME):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    print(f"wrote {repo_report}")
    print(f"accuracy {accuracy:.3f} vs baseline {baseline:.3f}; test rows {len(test)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
