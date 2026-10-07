# ADR-006: GitOps delivery — defer Flux; root Kustomize plus an in-house deployer

**Status:** Accepted **Deciders:** Gavin Kline

## Context

The cluster is described by root Kustomize (`clusters/home`) plus per-component bases in `deploy/`. A handful of operators are installed out of band: ESO and CNPG (server-side applies from git), and policy-controller and tailscale-operator (Helm). Hardware is old servers with 8 GB+ RAM per node; every MiB is shared with dind, Chromium, and agent workspaces.

Continuous delivery today is `deploy/deployer`:

| What | How | Cost |
| --- | --- | --- |
| Workloads that run homelab images (factory base, t3code, work-t3code, hermes, panel, knowledge) | CronJob every 5 min: `git clone main` → resolve each `ghcr.io/gwkline/homelab/<app>:latest` to its current digest → `kubectl apply` the target list | short Job, 50m / 64Mi request; namespaced RBAC for exactly the kinds it applies |

Everything else (namespaces, policies, services, config, operators, the deployer itself) deploys when a human runs `kubectl apply -k clusters/home` or the component base.

## Options

- **A. Adopt Flux now.** Merge-to-deployed for every manifest, continuous drift correction and prune, HelmReleases for the operators. Costs: four controllers and their CRDs on the recovery path, a second credential at bootstrap (Flux's git key), debugging through `Kustomization`/`HelmRelease` status instead of `kubectl diff`, and prune risk on a cluster that deliberately runs out-of-band objects (hermes-created Jobs).
- **B. Defer (chosen).** The highest-frequency change class (new images, factory manifests) is already automated by the deployer for one short Job every 5 minutes. Revisit on the triggers in D5.
- **C. Reject outright.** Rejected: the factory is building toward higher merge rates, and Helm-managed operators are accumulating; a permanent "no" forces a worse choice later.

## Decisions

### D1. Dead-disk recovery

| Step | Today | With Flux |
| --- | --- | --- |
| OS + k3s + tailscale | `bootstrap/bootstrap.sh` | same |
| CD install | — (`clusters/home` includes the deployer) | `flux bootstrap github` (repo-scoped credential) |
| Hand-entered secrets | 1Password service-account token | same, plus Flux's git credential |
| Apply | operator pre-applies + `kubectl apply -k clusters/home` ([rebuild runbook](../rebuild-runbook.md)) | one root `Kustomization` |
| Verify | `scripts/rebuild-check.sh` | same + `flux get kustomizations` |

Recovery time is dominated by k3s install and image pulls, not applies, so Flux buys little here.

### D2. Secrets

Identical under both options: one hand-entered 1Password service-account token, after which ESO syncs everything else. Flux would only add its own git credential.

### D3. Steady-state cost (estimate, unmeasured)

A minimal Flux install (source, kustomize, helm, notification controllers) is ~300–500 Mi RSS combined (~4–6% of one node) and ~1–3% of a core. It would displace only the deployer's short Jobs. Measure before adopting:

```sh
kubectl top pods -n flux-system --sum
```

### D4. What each layer fixes

| Drift | Today | Flux |
| --- | --- | --- |
| New image after a CI build | deployer (≤ 5 min) | absorbed |
| Factory / workload manifest change | deployer (targets only) | absorbed |
| Other manifest drift (manual edits, partial applies) | `rebuild-check.sh` detects; human re-applies | corrected + pruned |
| Operator Helm values | runbook commands | HelmRelease — a genuine win |
| Hermes gateway dead inside its pod | probes | not fixed (in-pod state) |
| Files on PVCs | initContainers | not fixed (volume state) |

### D5. Revisit triggers

Install Flux when a timed rebuild passes with zero out-of-band fixes **and** any one of:

1. Merged agent PRs average ≥ 5/week for 4 weeks, or the factory merges without a human;
2. A third Helm-managed operator lands;
3. A drift incident outside the deployer's targets causes an outage continuous reconciliation would have prevented;
4. Rebuild timing shows applies are a meaningful share of recovery time.

## Consequences

- No new controllers, CRDs, or credentials.
- Images and workload specs roll out within one deployer pass of a merge; rollback is `kubectl rollout undo` or reverting the commit.
- Manifests outside the deployer's targets, and changes to `deploy/deployer` itself, still need a manual apply after merge.
- If the deployer grows a second feature (pruning, health gating), re-read this ADR.
