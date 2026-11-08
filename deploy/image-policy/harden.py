#!/usr/bin/env python3
"""Apply the status-only image webhook exclusion after Helm install/upgrade."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

path = Path(__file__).with_name("post-renderer.py")
spec = importlib.util.spec_from_file_location("image_policy_renderer", path)
assert spec is not None and spec.loader is not None
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise RuntimeError("Image-policy kubectl operation failed; inspect cluster health")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--server")
    args = parser.parse_args()
    command = ["kubectl", "--kubeconfig", args.kubeconfig,
               "--insecure-skip-tls-verify=false", "--request-timeout=20s"]
    if args.server:
        command += ["--server", args.server]
    lookup = ["get", "mutatingwebhookconfiguration", "policy.sigstore.dev", "-o", "json"]
    original = json.loads(run(command + lookup))
    hardened = renderer.harden([original])[0]
    patches = []
    for index, webhook in enumerate(hardened["webhooks"]):
        if webhook.get("name") == "policy.sigstore.dev":
            patches += [
                {"op": "test", "path": f"/webhooks/{index}/name", "value": webhook["name"]},
                {"op": "add", "path": f"/webhooks/{index}/matchConditions", "value": webhook["matchConditions"]},
            ]
    patch = ["patch", "mutatingwebhookconfiguration", "policy.sigstore.dev",
             "--type=json", "-p", json.dumps(patches)]
    run(command + patch + ["--dry-run=server"])
    run(command + patch)
    actual = json.loads(run(command + lookup))
    for old, new in zip(original["webhooks"], actual["webhooks"], strict=True):
        assert old["name"] == new["name"]
        assert old.get("rules") == new.get("rules")
        assert old.get("namespaceSelector") == new.get("namespaceSelector")
        assert old.get("failurePolicy") == new.get("failurePolicy")
        if new["name"] == "policy.sigstore.dev":
            expected = next(item for item in hardened["webhooks"] if item["name"] == new["name"])
            assert new["matchConditions"] == expected["matchConditions"]
    print("Verified status-only exclusion; image rules, namespace scope and fail-closed admission preserved")


if __name__ == "__main__":
    main()
