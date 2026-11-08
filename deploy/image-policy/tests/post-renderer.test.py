#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "post-renderer.py"
spec = importlib.util.spec_from_file_location("image_policy_renderer", path)
assert spec is not None and spec.loader is not None
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class HardeningTests(unittest.TestCase):
    def documents(self):
        webhook = {
            "name": "policy.sigstore.dev",
            "failurePolicy": "Fail",
            "namespaceSelector": {"matchLabels": {"policy.sigstore.dev/include": "true"}},
            "rules": [{"operations": ["CREATE", "UPDATE"], "resources": ["pods", "pods/status"]}],
            "clientConfig": {"service": {"name": "webhook", "namespace": "cosign-system"}},
        }
        return [
            {"kind": "MutatingWebhookConfiguration", "metadata": {"name": "policy.sigstore.dev"}, "webhooks": [webhook]},
            {"kind": "ValidatingWebhookConfiguration", "metadata": {"name": "policy.sigstore.dev"}, "webhooks": [copy.deepcopy(webhook)]},
        ]

    def test_only_status_predicate_changes(self):
        original = self.documents()
        untouched = copy.deepcopy(original)
        actual = renderer.harden(original)
        self.assertEqual(original, untouched)
        condition = actual[0]["webhooks"][0].pop("matchConditions")
        self.assertEqual(condition, [{"name": renderer.CONDITION_NAME, "expression": renderer.CONDITION_EXPRESSION}])
        self.assertEqual(actual, original)
        self.assertIn("!has(request.subResource)", renderer.CONDITION_EXPRESSION)

    def test_preserves_other_conditions_and_is_idempotent(self):
        original = self.documents()
        existing = {"name": "another-required-check", "expression": "true"}
        original[0]["webhooks"][0]["matchConditions"] = [existing]
        actual = renderer.harden(original)
        self.assertEqual(actual[0]["webhooks"][0]["matchConditions"][0], existing)
        self.assertEqual(renderer.harden(actual), actual)

    def test_refuses_fail_open(self):
        original = self.documents()
        original[0]["webhooks"][0]["failurePolicy"] = "Ignore"
        with self.assertRaises(ValueError):
            renderer.harden(original)

    def test_refuses_missing_or_duplicate_webhook(self):
        with self.assertRaises(ValueError):
            renderer.harden([])
        original = self.documents()
        with self.assertRaises(ValueError):
            renderer.harden(original + [copy.deepcopy(original[0])])


if __name__ == "__main__":
    unittest.main()
