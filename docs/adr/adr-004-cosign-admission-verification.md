# ADR-004: Enforce cosign image verification at admission — sigstore policy-controller

**Status:** Accepted (2026-09-03) **Deciders:** Gavin Kline, ox-alpha **Implements:** #91 · **Depends on:** #35 (immutable digests) · **Supersedes:** nothing

## Context

CI already signs every homelab image keylessly with cosign on push to `main` (`.github/workflows/ci.yaml`, `id-token: write` + `cosign sign`). Until now, verifying that signature was a manual `cosign verify` command — a control that exists on paper only. #35 pinned every deployed homelab image to an immutable `@sha256` digest, so the remaining gap is enforcement: nothing stops a pod from being admitted with an unsigned or foreign-signed `ghcr.io/gwkline/homelab/**` image.

Constraints: two old k3s nodes (8 GB+ RAM, shared with dind/Chromium/agent workspaces), hand-applied root Kustomize with no GitOps controller (ADR-003), and a documented reluctance to add controllers and CRDs (ADR-003 D3/D7). GHCR packages may be private.

## Options

### A. CI-only verification (interim, not enough alone)

Run `cosign verify` in CI against every digest a manifest deploys. Zero cluster cost, but the control never reaches the cluster: any path that creates pods outside CI (a compromised deploy script, a manually applied manifest, an agent with Job-creation RBAC — panel, dispatcher, hermes via executor) runs images with no signature check. Rejected as the end state; kept as the complementary gate (`scripts/check-image-pins.sh` in the CI validate job) that keeps every homelab ref digest-pinned so admission verification has a stable object to verify.

### B. sigstore policy-controller (chosen)

The admission controller purpose-built for cosign: a single webhook deployment in `cosign-system` plus two CRDs (`ClusterImagePolicy`, `TrustRoot`), installed from the sigstore helm chart (`policy-controller-0.10.7`, app `0.13.1`, webhook image itself digest-pinned). Maintained by the sigstore org on a monthly cadence; it is the reference consumer of the exact signature format CI already produces. k3s-compatible: it is a plain validating/mutating admission webhook — no node agents, no containerd changes, no kernel modules. Budget: one pod at `100m/128Mi` requests (`200m/512Mi` limits, chart defaults). Opt-in per namespace via the `policy.sigstore.dev/include=true` namespace label, which the API server evaluates before the webhook is ever called.

### C. Kyverno verifyImages

Also maintained and capable of cosign keyless verification, but it is a general policy engine: more CRDs, more controllers, and a rule language this repo has no other use for — a worse cost on the same hardware for one job. Rejected per the ADR-003 D3 reasoning (smallest sufficient control plane).

## Decisions

### D1. Mechanism and install shape

policy-controller, installed out-of-band by helm like tailscale-operator and ESO: `helm upgrade --install policy-controller sigstore/policy-controller --version 0.10.7 -n cosign-system --create-namespace` (pinned in `scripts/recovery-drill.sh` and the rebuild runbook). The `ClusterImagePolicy` itself is plain kustomize in `deploy/image-policy/base`, applied right after the install and before any workload apply — verification must exist before the first pod is admitted. The webhook config ships `failurePolicy: Fail`; the webhook self-reconciles its own rules.

### D2. Trusted identity

One `ClusterImagePolicy` (`homelab-images`) matches glob `ghcr.io/gwkline/homelab/**` and accepts exactly one authority: keyless Fulcio + Rekor with identity `issuer: https://token.actions.githubusercontent.com`, `subject: https://github.com/gwkline/homelab/.github/workflows/ci.yaml@refs/heads/main` — the OIDC `sub` claim of this repo's CI workflow on `main`, which is the only workflow that signs. Any other identity (another repo's workflow, a personal key, no signature) fails. If a second signing workflow is ever added, its `sub` must be appended to the identities list in a reviewed diff.

### D3. Third-party images: explicitly out of scope

The policy matches only `ghcr.io/gwkline/homelab/**`. Images matching no `ClusterImagePolicy` are admitted — postgres, grafana, busybox, ESO and other third-party images are **deliberately default-allowed**, not blocked and not accidentally blocked. Rationale: we cannot produce third-party signatures, so a signature requirement would brick the cluster; their control is the same one as today — `tag@sha256` digest pins bumped by Renovate (README "Supply chain"). Enforcement scope is additionally opt-in per namespace (`policy.sigstore.dev/include=true` on `agents` and `sandbox` only), so `database` (CNPG), `tailscale`, and system namespaces are outside the webhook entirely. Labeling a namespace is the single explicit act that puts it under image policy.

### D4. Failure behavior and break-glass

Fail-closed by design, with an escape hatch for each layer:

| Failure | Effect | Break-glass |
| --- | --- | --- |
| policy-controller down (`failurePolicy: Fail`) | **All** pod creation in included namespaces (`agents`, `sandbox`) fails — not just homelab images, because the API server cannot reach the webhook | `kubectl label ns <ns> policy.sigstore.dev/include-` (namespaceSelector is evaluated API-server-side, so this works while the webhook is down); or delete the webhook configs: `kubectl delete validatingwebhookconfiguration policy.sigstore.dev && kubectl delete mutatingwebhookconfiguration policy.sigstore.dev` (or `helm uninstall policy-controller -n cosign-system`) |
| Sigstore public infra (Fulcio/Rekor) unreachable | Homelab-image admission fails; third-party images unaffected (no matching policy) | wait for recovery; if prolonged, `kubectl delete clusterimagepolicy homelab-images` admits everything (webhook up, nothing matches) |
| Private GHCR + missing pull credentials | Webhook cannot fetch the signature → admission fails | wire the `ghcr-pull` secret into pod specs (README "GHCR images") — the webhook uses the pod's imagePullSecrets |
| Accidentally over-broad policy | New homelab image rejected after merge | fix the CIP; interim: `kubectl delete clusterimagepolicy homelab-images` (webhook stays up for the tag-resolution mutating webhook) |

Every break-glass use is a drill finding: record it and restore enforcement before the next drill.

### D5. Recovery/bootstrap ordering

The policy must be in force before workloads are applied, so the drill stage `image-policy` sits after `namespaces` (which carries the include labels) and before `secrets`/`workloads` (docs/rebuild-runbook.md step 2b). On a fresh cluster the sequence is: namespaces labeled → policy-controller helm install → `kubectl apply -k deploy/image-policy/base` → workloads admitted only when their digests verify. Fresh-boot bootstrap (`bootstrap/bootstrap.sh`) needs no changes — it stops at a Ready node; all of this is cluster-phase.

### D6. What remains in CI

`scripts/check-image-pins.sh` (validate job) fails any new non-digest homelab image ref: signatures and admission verification both bind to digests, so a tag ref would be un-verifyable at admission. CI does not run `cosign verify` itself — the admission webhook is the enforcement point, and duplicating it in CI would only re-verify what the cluster refuses to run unsigned.

## Consequences

- New namespace `cosign-system`, two CRDs, one webhook pod (~128 Mi) — accepted under ADR-003 D7's "third helm-managed operator" trigger: this is the third helm install, recorded here.
- A fresh rebuild now depends on sigstore public infrastructure (Fulcio/Rekor) reachability during workload admission; a prolonged outage requires the documented break-glass, which is a drill finding per the runbook rules.
- k3s compatibility is expected-low-risk (plain admission webhook), but the chart's tested matrix lists ≤ 1.29 while this cluster runs newer k3s — confirm webhook readiness in the drill stage; if the controller proves incompatible, this ADR is reopened and CI-only verification (option A) becomes the documented interim.
- Rollback: `helm uninstall policy-controller -n cosign-system` returns admission to the pre-#91 state; manifests in git are unaffected.
