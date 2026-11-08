# Image admission policy

Sigstore policy-controller admits a `ghcr.io/gwkline/homelab/**` image only if it carries a keyless cosign signature from this repo's `ci.yaml` workflow on `main`. Third-party images match no policy and are admitted; their digest pin is the guarantee. See [ADR-004](../../docs/adr/adr-004-cosign-admission-verification.md).

The webhook only intercepts namespaces labeled `policy.sigstore.dev/include: "true"` (`agents`, `sandbox`, `work`; see `deploy/namespaces`). It resolves tags to digests at admission and verifies the signature on the digest.

## Apply

Install the controller before `clusters/home`, which applies the policy. The hardening helper uses Python 3 and kubectl, and works independently of Helm's version-specific post-renderer plugin interface.

```sh
helm repo add sigstore https://sigstore.github.io/helm-charts
helm --kubeconfig ~/kubeconfig-homelab upgrade --install policy-controller sigstore/policy-controller \
  --version 0.10.7 -n cosign-system --create-namespace \
  --values deploy/image-policy/values.yaml
python3 deploy/image-policy/harden.py --kubeconfig ~/kubeconfig-homelab
kubectl --kubeconfig ~/kubeconfig-homelab -n cosign-system rollout status deploy/policy-controller-webhook
```

Keep these values and run the helper on every upgrade. With Helm 4, add `--server-side=false`: the webhook controller owns its namespace selector, so server-side Helm upgrades conflict with that live field. Helm 3 does not need this flag. Do not force field ownership or add another writable home volume—the chart already supplies one, and extra entries duplicate the same mount.

The controller has cluster-critical priority and a disk-pressure toleration so image admission can recover while ordinary work is blocked. The helper adds a status-only exclusion to the workload mutating webhook, preserving its image rules, namespace selector, and `failurePolicy: Fail`. Kubernetes status updates cannot change workload image specifications; sending them to an unavailable image webhook strands dead pods behind stale Ready flags. The predicate handles ordinary requests that omit `subResource`, and still routes CREATE, spec UPDATE, and ephemeral-container image changes through the existing image checks. The helper verifies the exact live target after applying.

## Verify

A rollout of any homelab workload (e.g. `kubectl -n agents rollout status deploy/panel`) proves that signed images are admitted. `kubectl -n sandbox run t --image=ghcr.io/gwkline/homelab/<image>:<unsigned-tag>` must be denied with "no matching signatures".

## Break-glass

Enforcement fails closed. From least to most drastic:

1. Exempt one namespace: `kubectl label ns <ns> policy.sigstore.dev/include-`
2. Drop the policy but keep the webhook: `kubectl delete clusterimagepolicy homelab-images`
3. Unhook the webhook entirely, for when cosign-system is down and no pods can start:
   ```sh
   kubectl delete validatingwebhookconfiguration policy.sigstore.dev
   kubectl delete mutatingwebhookconfiguration policy.sigstore.dev
   ```
   To restore, re-run the helm install, then `kubectl apply -k deploy/image-policy/base`.

Failure modes: if the webhook is down, no pods can be created in included namespaces. If Fulcio or Rekor is unreachable, only homelab images are rejected.
