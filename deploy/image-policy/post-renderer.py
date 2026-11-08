#!/usr/bin/env python3
"""Keep image admission fail-closed without coupling workload status to it."""

import copy
import sys

CONDITION_NAME = "exclude-status-updates"
# Ordinary admission requests may omit subResource entirely.
CONDITION_EXPRESSION = "!has(request.subResource) || request.subResource != 'status'"


def harden(documents):
    result = copy.deepcopy(documents)
    found = 0
    for document in result:
        if not isinstance(document, dict):
            continue
        if document.get("kind") != "MutatingWebhookConfiguration":
            continue
        if document.get("metadata", {}).get("name") != "policy.sigstore.dev":
            continue
        for webhook in document.get("webhooks", []):
            if webhook.get("name") != "policy.sigstore.dev":
                continue
            if webhook.get("failurePolicy") != "Fail":
                raise ValueError("Image admission must remain fail-closed")
            conditions = webhook.get("matchConditions", []) or []
            conditions = [
                condition for condition in conditions
                if condition.get("name") != CONDITION_NAME
            ]
            webhook["matchConditions"] = conditions + [{
                "name": CONDITION_NAME,
                "expression": CONDITION_EXPRESSION,
            }]
            found += 1
    if found != 1:
        raise ValueError("Expected exactly one Sigstore workload mutating webhook")
    return result


def main():
    try:
        import yaml
    except ImportError:
        raise SystemExit("The image-policy post-renderer requires Python 3 and PyYAML") from None
    try:
        documents = list(yaml.safe_load_all(sys.stdin))
        hardened = harden(documents)
    except (ValueError, yaml.YAMLError) as error:
        raise SystemExit(str(error)) from None
    yaml.safe_dump_all(hardened, sys.stdout, sort_keys=False)


if __name__ == "__main__":
    main()
