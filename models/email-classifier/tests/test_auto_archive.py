"""Guard-logic tests for the >0.9 auto-archive authority. Synthetic data only.

Every message below is invented; no real mail content appears here (the
repo is public and carries code only).
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
TARGET = (
    pathlib.Path(__file__).resolve().parents[1]
    / "predictions"
    / "auto_archive.py"
)
spec = importlib.util.spec_from_file_location("auto_archive", TARGET)
assert spec is not None and spec.loader is not None
aa = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = aa
spec.loader.exec_module(aa)

NEURAL = "neural-v4-qwen25-15b-lora-20261119"
CLASSICAL = "v1.5-20261119-0920"


def row(**over):
    """A classify.py stdout entry, synthetic, with defaults that qualify."""
    base = {
        "id": "synthetic0001",
        "from": "Deals <deals@example-shop.com>",
        "subject": "Flash sale: 50% off everything this weekend",
        "snippet": "Members-only pricing ends Sunday night. Shop now.",
        "labelIds": [],
        "failed": False,
        "predicted": "archive",
        "confidence": 0.97,
        "probabilities": {"archive": 0.97, "respond": 0.01, "mark-read": 0.02},
        "model_version": NEURAL,
    }
    # `from` is a Python keyword, so callers pass it as from_="...".
    if "from_" in over:
        base["from"] = over.pop("from_")
    base.update(over)
    return base


def classify_out(*entries, ok=True, degraded=False):
    return {
        "ok": ok,
        "degraded": degraded,
        "model_version": entries[0]["model_version"] if entries else None,
        "count": len(entries),
        "predictions": list(entries),
    }


class TestEvaluate(unittest.TestCase):
    def test_promo_noise_qualifies(self):
        ok, reason = aa.evaluate(row())
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")

    def test_p_archive_boundary_strict(self):
        self.assertFalse(aa.evaluate(row(probabilities={"archive": 0.9, "respond": 0.01, "mark-read": 0.09}))[0])
        self.assertTrue(aa.evaluate(row(probabilities={"archive": 0.9000001, "respond": 0.01, "mark-read": 0.09}))[0])

    def test_p_respond_boundary_strict(self):
        probs = lambda pr: {"archive": 0.95, "respond": pr, "mark-read": 0.0}
        self.assertFalse(aa.evaluate(row(probabilities=probs(0.05)))[0])
        self.assertTrue(aa.evaluate(row(probabilities=probs(0.0499)))[0])

    def test_flagged_respond_and_mark_read_are_protected(self):
        self.assertEqual(
            aa.evaluate(row(predicted="respond"))[1], "flagged:respond"
        )
        self.assertEqual(
            aa.evaluate(row(predicted="mark-read"))[1], "flagged:mark-read"
        )

    def test_classical_row_never_qualifies(self):
        ok, reason = aa.evaluate(row(model_version=CLASSICAL))
        self.assertFalse(ok)
        self.assertEqual(reason, "classical_row")

    def test_missing_model_version_never_qualifies(self):
        self.assertEqual(aa.evaluate(row(model_version=None))[1], "classical_row")

    def test_failed_prediction_skipped(self):
        self.assertEqual(aa.evaluate(row(failed=True, probabilities=None))[1], "prediction_failed")

    def test_probabilities_missing_skipped(self):
        self.assertEqual(aa.evaluate(row(probabilities=None))[1], "prediction_failed")
        self.assertEqual(
            aa.evaluate(row(probabilities={"archive": None, "respond": None}))[1],
            "probabilities_missing",
        )

    def test_rounded_p_respond_at_bound_is_protected(self):
        # The API rounds probabilities to 4 dp; 0.0501 rounds to 0.0501 -> skip.
        self.assertFalse(
            aa.evaluate(row(probabilities={"archive": 0.93, "respond": 0.0501, "mark-read": 0.02}))[0]
        )

    def assert_protected(self, name, **over):
        ok, reason = aa.evaluate(row(**over))
        self.assertFalse(ok, f"expected protected:{name}, got eligible")
        self.assertTrue(
            reason.startswith("protected:"),
            f"expected protected:{name}, got {reason}",
        )
        self.assertIn(name, reason)

    def test_security_class(self):
        self.assert_protected(
            "security",
            from_="Google <no-reply@accounts.google.com>",
            subject="New sign-in on a new iPhone",
            snippet="If you did not sign in, secure your account now.",
        )
        self.assert_protected(
            "security",
            subject="Your verification code",
            snippet="Enter code 448192 to verify your identity",
        )
        self.assert_protected(
            "security",
            from_="Apple <no_reply@id.apple.com>",
            subject="Password reset requested",
        )

    def test_security_credential_lifecycle_class(self):
        # GitHub PAT-added style notices: security mail even when the
        # classifier scores them archive at 0.99+.
        self.assert_protected(
            "security",
            from_="GitHub <noreply@github.com>",
            subject="A fine-grained personal access token has been added to your account",
            snippet="A personal access token was recently added. View your token details.",
        )
        self.assert_protected(
            "security",
            subject="Possible passwords detected in your repository",
        )
        self.assert_protected(
            "security",
            subject="Your API key was rotated",
        )

    def test_shipping_class(self):
        self.assert_protected(
            "shipping",
            from_="USPS <noreply@usps.com>",
            subject="Your package is out for delivery",
        )
        self.assert_protected(
            "shipping",
            subject="Time to Ship your Sneaker Listing",
            snippet="Ship the item within 3 business days.",
        )
        self.assert_protected(
            "shipping",
            from_="UPS <noreply@ups.com>",
            subject="Tracking update: in transit",
        )

    def test_receipt_class(self):
        self.assert_protected(
            "receipt",
            from_="Apple <no_reply@email.apple.com>",
            subject="Your receipt from Apple",
            snippet="Thanks for your purchase. Order W123456789.",
        )
        self.assert_protected(
            "receipt",
            subject="Payment received -- thank you",
        )
        self.assert_protected(
            "receipt",
            subject="Your November statement is ready",
        )

    def test_calendar_class(self):
        self.assert_protected(
            "calendar",
            from_="Google Calendar <calendar-notification@google.com>",
            subject="Invitation: Sprint review @ Wed Nov 25",
        )

    def test_travel_class(self):
        self.assert_protected(
            "travel",
            from_="Budget <budget@e.budget.com>",
            subject="Reservation reminder: car rental pickup",
        )

    def test_govdash_class(self):
        self.assert_protected(
            "govdash",
            from_="GovDash <updates@govdash.com>",
            subject="New opportunity update",
        )

    def test_unrelated_words_do_not_trigger(self):
        # "relationship", "cup", "warranty" style false-positive guards.
        ok, _ = aa.evaluate(
            row(
                from_="Newsletter <news@example.org>",
                subject="Building a good relationship with your tools",
                snippet="A cup of coffee, a warranty tale, and no parcels.",
            )
        )
        self.assertTrue(ok)


class TestGateStatus(unittest.TestCase):
    def test_neural_day(self):
        gate, note = aa.gate_status(classify_out(row()))
        self.assertEqual(gate, "neural")
        self.assertIsNone(note)

    def test_classical_fallback_day(self):
        gate, note = aa.gate_status(classify_out(row(model_version=CLASSICAL)))
        self.assertEqual(gate, "classical_fallback")
        self.assertIn("auto-archive", note)
        self.assertIn("classical", note)

    def test_mixed_day(self):
        out = classify_out(row(id="a"), row(id="b", model_version=CLASSICAL))
        gate, note = aa.gate_status(out)
        self.assertEqual(gate, "mixed")
        self.assertIn("neural-scored", note)

    def test_degraded(self):
        gate, note = aa.gate_status(classify_out(ok=False, degraded=True))
        self.assertEqual(gate, "degraded")
        self.assertIn("degraded", note.lower())

    def test_no_predictions(self):
        out = classify_out(row(failed=True, probabilities=None))
        gate, note = aa.gate_status(out)
        self.assertEqual(gate, "no_predictions")


class TestPlan(unittest.TestCase):
    def test_write_form_removes_inbox_keeps_unread(self):
        p = aa.plan(classify_out(row()), cap=50)
        self.assertEqual(p["write"]["removeLabelIds"], ["INBOX"])
        self.assertEqual(p["write"]["keep"], ["UNREAD"])

    def test_cap_trims_most_confident_first(self):
        entries = [
            row(id=f"synthetic{i:04d}",
                probabilities={"archive": 0.905 + i * 0.001, "respond": 0.001,
                              "mark-read": 0.01})
            for i in range(55)
        ]
        p = aa.plan(classify_out(*entries), cap=50)
        self.assertEqual(len(p["qualifying"]), 50)
        self.assertEqual(len(p["deferred_over_cap"]), 5)
        self.assertEqual(p["total"], 55)
        # sorted by p_archive desc: the 55%..51% tail survives
        self.assertEqual(
            [q["id"] for q in p["qualifying"]][:3],
            ["synthetic0054", "synthetic0053", "synthetic0052"],
        )
        self.assertEqual(p["deferred_over_cap"][0]["reason"], "over_cap")

    def test_skipped_reasons_recorded(self):
        p = aa.plan(
            classify_out(
                row(id="keep1"),
                row(id="drop1", predicted="respond"),
                row(id="drop2", model_version=CLASSICAL),
                row(id="drop3", probabilities={"archive": 0.5, "respond": 0.1,
                                                "mark-read": 0.4}),
            ),
            cap=50,
        )
        self.assertEqual([q["id"] for q in p["qualifying"]], ["keep1"])
        reasons = {s["id"]: s["reason"] for s in p["skipped"]}
        self.assertEqual(reasons["drop1"], "flagged:respond")
        self.assertEqual(reasons["drop2"], "classical_row")
        self.assertEqual(reasons["drop3"], "p_archive<=0.9")

    def test_classical_day_plan_has_no_qualifying_and_carries_note(self):
        p = aa.plan(classify_out(row(model_version=CLASSICAL)), cap=50)
        self.assertEqual(p["gate"], "classical_fallback")
        self.assertEqual(p["qualifying"], [])
        self.assertIn("classical", p["briefing_note"])
        # the classical row is still visible in skipped, not silently gone
        self.assertEqual(p["skipped"][0]["reason"], "classical_row")

    def test_plan_is_deterministic(self):
        entries = [row(id=f"synthetic{i:04d}") for i in range(10)]
        a = aa.plan(classify_out(*entries), cap=50)
        b = aa.plan(classify_out(*entries), cap=50)
        self.assertEqual(json.dumps(a), json.dumps(b))


class TestLog(unittest.TestCase):
    def verified(self, **over):
        base = {
            "id": "synthetic0001",
            "from": "Deals <deals@example-shop.com>",
            "subject": "Flash sale: 50% off everything this weekend",
            "predicted": "archive",
            "confidence": 0.97,
            "p_archive": 0.97,
            "p_respond": 0.01,
            "model_version": NEURAL,
            "verified": True,
        }
        base.update(over)
        return base

    def test_log_row_shape_and_no_snippet(self):
        rows = aa.log_rows([self.verified()])
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertTrue(r["auto_archive"])
        self.assertEqual(r["write"], "remove_INBOX_keep_UNREAD")
        self.assertEqual(r["message_id"], "synthetic0001")
        self.assertEqual(r["verified"], True)
        self.assertNotIn("snippet", r)
        self.assertEqual(
            sorted(r.keys()),
            ["auto_archive", "confidence", "from", "message_id", "model_version",
             "p_archive", "p_respond", "predicted", "subject", "ts",
             "verified", "write"],
        )

    def test_refuses_unverified(self):
        with self.assertRaises(ValueError):
            aa.log_rows([self.verified(verified=False)])

    def test_refuses_non_archive(self):
        with self.assertRaises(ValueError):
            aa.log_rows([self.verified(predicted="respond")])

    def test_refuses_rows_without_id(self):
        with self.assertRaises(ValueError):
            aa.log_rows([{"verified": True, "predicted": "archive"}])

    def test_append_log_writes_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(pathlib.Path(tmp) / "predictions.jsonl")
            n = aa.append_log(path, aa.log_rows([self.verified(id="a"),
                                                  self.verified(id="b")]))
            self.assertEqual(n, 2)
            lines = pathlib.Path(path).read_text().strip().splitlines()
            self.assertEqual(len(lines), 2)
            parsed = [json.loads(x) for x in lines]
            self.assertEqual([p["message_id"] for p in parsed], ["a", "b"])
            self.assertTrue(all(p["auto_archive"] for p in parsed))


if __name__ == "__main__":
    unittest.main()
