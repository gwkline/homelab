# ADR-004: Enforce cosign image verification at admission — sigstore policy-controller

**Status:** Accepted, implemented (`deploy/image-policy/base`, enforcing in `agents`, `sandbox` and `work`) **Deciders:** Gavin Kline

## Context

CI signs every homelab image keylessly with cosign on push to `main` (`.github/workflows/ci.yaml`, `id-token: write` + `cosign sign`) and tags `sha-<short>` and `:latest` only after signing. Without admission enforcement, nothing stops a pod from running an unsigned or foreign-signed `ghcr.io/gwkline/homelab/**` image.

Constraints: one k3s node whose memory is shared with agent workspaces, no GitOps controller (ADR-006), and a reluctance to add controllers and CRDs. GHCR packages may be private.

## Options

### A. CI-only verification (interim, not enough alone)

Run `cosign verify` in CI against every digest a manifest deploys. Zero cluster cost, but the control never reaches the cluster: any path that creates pods outside CI (a compromised deploy script, a manually applied manifest, a workload with Job-creation RBAC — the panel and the factory orchestrator) runs images with no signature check. Rejected.

### B. sigstore policy-controller (chosen)

The admission controller purpose-built for cosign: a single webhook deployment in `cosign-system` plus two CRDs (`ClusterImagePolicy`, `TrustRoot`), installed from the sigstore helm chart (`policy-controller-0.10.7`, app `0.13.1`, webhook image itself digest-pinned). Maintained by the sigstore org on a monthly cadence; it is the reference consumer of the exact signature format CI already produces. k3s-compatible: it is a plain validating/mutating admission webhook — no node agents, no containerd changes, no kernel modules. Budget: one pod at `100m/128Mi` requests (`200m/512Mi` limits, chart defaults). Opt-in per namespace via the `policy.sigstore.dev/include=true` namespace label, which the API server evaluates before the webhook is ever called.

### C. Kyverno verifyImages

Also maintained and capable of cosign keyless verification, but it is a general policy engine: more CRDs, more controllers, and a rule language this repo has no other use for — a worse cost on the same hardware for one job. Rejected per the ADR-006 D3 reasoning (smallest sufficient control plane).

## Decisions

### D1. Mechanism and install shape

policy-controller, installed out of band by Helm like tailscale-operator: `helm upgrade --install policy-controller sigstore/policy-controller --version 0.10.7 -n cosign-system --create-namespace` (pinned in `scripts/recovery-drill.sh` and the [rebuild runbook](../rebuild-runbook.md)). The `ClusterImagePolicy` itself is plain kustomize in `deploy/image-policy/base`, applied right after the install and before any workload apply — verification must exist before the first pod is admitted. The webhook config ships `failurePolicy: Fail`; the webhook self-reconciles its own rules.

### D2. Trusted identity

One `ClusterImagePolicy` (`homelab-images`) matches glob `ghcr.io/gwkline/homelab/**` and accepts exactly one authority: keyless Fulcio + Rekor with identity `issuer: https://token.actions.githubusercontent.com`, `subject: https://github.com/gwkline/homelab/.github/workflows/ci.yaml@refs/heads/main` — the OIDC `sub` claim of this repo's CI workflow on `main`, which is the only workflow that signs. Any other identity (another repo's workflow, a personal key, no signature) fails. If a second signing workflow is ever added, its `sub` must be appended to the identities list in a reviewed diff.

### D3. Third-party images: explicitly out of scope

The policy matches only `ghcr.io/gwkline/homelab/**`. Images matching no `ClusterImagePolicy` are admitted — postgres, grafana, busybox, ESO and other third-party images are **deliberately default-allowed**, not blocked and not accidentally blocked. Rationale: we cannot produce third-party signatures, so a signature requirement would brick the cluster; their control is `tag@sha256` digest pins bumped by Renovate. Enforcement scope is additionally opt-in per namespace (`policy.sigstore.dev/include=true` on `agents`, `sandbox`, and `work` only), so `database` (CNPG), `tailscale`, and system namespaces are outside the webhook entirely. Labeling a namespace is the single explicit act that puts it under image policy.

### D4. Failure behavior and break-glass

Fail-closed by design, with an escape hatch for each layer:

| Failure | Effect | Break-glass |
| --- | --- | --- |
| policy-controller down (`failurePolicy: Fail`) | **All** pod creation in included namespaces (`agents`, `sandbox`, `work`) fails — not just homelab images, because the API server cannot reach the webhook | `kubectl label ns <ns> policy.sigstore.dev/include-` (namespaceSelector is evaluated API-server-side, so this works while the webhook is down); or delete the webhook configs: `kubectl delete validatingwebhookconfiguration policy.sigstore.dev && kubectl delete mutatingwebhookconfiguration policy.sigstore.dev` (or `helm uninstall policy-controller -n cosign-system`) |
| Sigstore public infra (Fulcio/Rekor) unreachable | Homelab-image admission fails; third-party images unaffected (no matching policy) | wait for recovery; if prolonged, `kubectl delete clusterimagepolicy homelab-images` admits everything (webhook up, nothing matches) |
| Private GHCR + missing pull credentials | Webhook cannot fetch the signature → admission fails | wire the `ghcr-pull` secret into pod specs ([secrets inventory](../secrets-inventory.md)) — the webhook uses the pod's imagePullSecrets |
| Accidentally over-broad policy | New homelab image rejected after merge | fix the CIP; interim: `kubectl delete clusterimagepolicy homelab-images` (webhook stays up for the tag-resolution mutating webhook) |

Every break-glass use is a drill finding: record it and restore enforcement before the next drill.

### D5. Recovery/bootstrap ordering

The policy must be in force before workloads are applied, so policy-controller is installed before `kubectl apply -k clusters/home`, which carries both the namespace include labels and the `ClusterImagePolicy` ([rebuild runbook](../rebuild-runbook.md)). Fresh-boot bootstrap (`bootstrap/bootstrap.sh`) needs no changes — it stops at a Ready node; all of this is cluster-phase.

### D6. What remains in CI

Manifests reference homelab images by tag; the webhook resolves the tag to a digest at admission and verifies that digest. CI does not run `cosign verify` itself — the admission webhook is the enforcement point, and duplicating it in CI would only re-verify what the cluster refuses to run unsigned.

## Consequences

- New namespace `cosign-system`, two CRDs, one webhook pod (~128 Mi). With tailscale-operator this is the second Helm install; a third trips ADR-006's Flux trigger.
- A fresh rebuild now depends on sigstore public infrastructure (Fulcio/Rekor) reachability during workload admission; a prolonged outage requires the documented break-glass, which is a drill finding per the runbook rules.
- k3s compatibility is expected-low-risk (plain admission webhook), but the chart's tested matrix lists ≤ 1.29 while this cluster runs newer k3s — confirm webhook readiness in the drill stage; if the controller proves incompatible, this ADR is reopened and CI-only verification (option A) becomes the documented interim.
- Rollback: `helm uninstall policy-controller -n cosign-system` removes enforcement; manifests in git are unaffected.
