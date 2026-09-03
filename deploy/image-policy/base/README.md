# Image admission policy (issue #91)

Sigstore policy-controller verifies, at pod-admission time, that every
`ghcr.io/gwkline/homelab/**` image carries a keyless cosign signature from
this repo's GitHub Actions workflow. Unsigned, foreign-signed, or
re-signed-by-someone-else images are rejected. Decision record:
[ADR-004](../../../docs/adr/adr-004-cosign-admission-verification.md).

## What enforces what

- `clusterimagepolicy.yaml` — the only trusted authority is the CI workflow
  identity (`https://github.com/gwkline/homelab/.github/workflows/ci.yaml@refs/heads/main`)
  verified against public Fulcio + Rekor.
- `deploy/namespaces.yaml` — `agents` and `sandbox` carry the
  `policy.sigstore.dev/include: "true"` label: the webhook intercepts only
  labeled namespaces (API-server-side `namespaceSelector`), so `database`,
  `tailscale`, and system namespaces are out of scope by construction.
- Third-party images (postgres, grafana, busybox, …) match no policy and are
  admitted — explicit default-allow (ADR-004 D3). Their guarantee is the
  digest pin (`tag@sha256`), not a signature.
- CI (`scripts/check-image-pins.sh`) rejects any homelab image ref that is
  not an `@sha256` digest — verification binds to digests, never tags.

## Install and ordering (recovery/bootstrap)

Applies in `scripts/recovery-drill.sh` stage `image-policy` and
[rebuild runbook](../../../docs/rebuild-runbook.md) step 2b. Order matters:

```sh
# 1. namespaces first — they carry the policy.sigstore.dev/include labels
kubectl apply -f deploy/namespaces.yaml
# 2. the controller (its CRDs must exist before the CIP can be applied)
helm repo add sigstore https://sigstore.github.io/helm-charts
helm upgrade --install policy-controller sigstore/policy-controller \
  --version 0.10.7 -n cosign-system --create-namespace
kubectl -n cosign-system rollout status deploy/policy-controller-webhook
# 3. the policy — before ANY workload apply
kubectl apply -k deploy/image-policy/base
# 4. only now: kubectl apply -k deploy/<workload>/base ...
```

The webhook image is digest-pinned by the chart itself; the chart version is
pinned in `scripts/recovery-drill.sh` (`POLICY_CHART_VERSION`) and the
runbook's pinned-versions table.

## Acceptance tests (admit / reject evidence)

Run after the stage above, from any machine with `kubectl` to the cluster:

```sh
# (a) correctly signed image is admitted — every normal deploy proves this,
#     but explicitly: re-apply panel (its digest is CI-signed) and confirm
#     the pods are admitted and go Ready
kubectl apply -k deploy/panel/base
kubectl -n agents rollout status deploy/panel   # pods admitted => verified

# (b) unsigned image is rejected — push any local build into the homelab
#     namespace WITHOUT the CI signing step, then try to run it:
docker build -t ghcr.io/gwkline/homelab/loop-agent:unsigned apps/loop-agent
docker push ghcr.io/gwkline/homelab/loop-agent:unsigned
kubectl -n sandbox run unsigned-test --image=ghcr.io/gwkline/homelab/loop-agent:unsigned
#    expected: admission denied, webhook reason "no matching signatures"

# (c) foreign identity is rejected — sign the same digest with any other
#     identity (another repo's workflow, or a local cosign key):
cosign sign --key cosign.key ghcr.io/gwkline/homelab/loop-agent@sha256:<digest>
kubectl -n sandbox run foreign-test --image=ghcr.io/gwkline/homelab/loop-agent@sha256:<digest>
#    expected: admission denied — the Fulcio identity does not match the CIP
```

Upstream `policy-tester` can also evaluate the CIP against a real image
without a cluster (sigstore/policy-controller repo, `make policy-tester`).

## Break-glass and failure behavior (ADR-004 D4)

Enforcement is fail-closed (`failurePolicy: Fail`). Escalation ladder, least
to most destructive:

1. **One namespace out** (webhook up or down — the namespaceSelector is
   evaluated by the API server): `kubectl label ns <ns> policy.sigstore.dev/include-`
2. **Whole policy off, webhook stays up**: `kubectl delete clusterimagepolicy homelab-images`
   (homelab images then match no policy and are admitted; tag→digest
   resolution keeps working).
3. **Webhook fully unhooked** (use when cosign-system is down and pods cannot
   start anywhere in agents/sandbox):
   ```sh
   kubectl delete validatingwebhookconfiguration policy.sigstore.dev
   kubectl delete mutatingwebhookconfiguration policy.sigstore.dev
   ```
   Restore with `helm upgrade --install` + `kubectl apply -k deploy/image-policy/base`.

Known failure modes: cosign-system webhook down ⇒ all pod creation in
included namespaces fails; Fulcio/Rekor unreachable ⇒ only homelab-image
admission fails; private GHCR without imagePullSecrets on the pod ⇒ the
webhook cannot fetch the signature and admission fails. Every break-glass
use is a drill finding — restore enforcement before the next drill.
