# ADR-003: GitOps delivery — defer Flux, keep root Kustomize + rebuild script

**Status:** Accepted (2026-09-02) **Deciders:** Gavin Kline, ox-alpha **Implements:** #37 · **Depends on:** #34 · **Supersedes:** nothing (first CD decision; codifies the "intentionally a CronJob instead of adding Flux" note in `deploy/factory/base/reconciler-cronjob.yaml`)

## Context

The cluster is applied by hand from root Kustomize: 14 kustomize bases, no overlays, ~10 `kubectl apply -k` lines during a rebuild (docs/rebuild-runbook.md, runbook-server-cluster.md §8). Declared workloads: 5 Deployments, 2 StatefulSets, 9 CronJobs (several opt-in: chaos, gvisor variant, dispatcher, backups). Two out-of-band Helm installs exist (tailscale-operator, External Secrets Operator). Hardware is old servers with 8 GB+ RAM per node; every MiB is shared with dind, Chromium, and agent workspaces.

Drift already bit once (2026-08-25 audit → docs/rebuild-runbook.md), and two partial automations now exist:

| Automation | What it reconciles | Cost |
| --- | --- | --- |
| `deploy/auto-deploy` (watcher, 60s) | image digests for panel/t3code/hermes → `kubectl rollout restart` when stale | 1 pod, 10m CPU / 32Mi request |
| `deploy/factory/base` reconciler (CronJob, 6×/h) | `git clone main` → `kubectl apply -k deploy/factory/base` | short Job, bounded 100m/128Mi |

Everything else (manifests for t3code, hermes, panel, homepage, policies, namespaces) deploys only when a human runs `kubectl apply`. #34 (fast teardown→bring-up recovery) is the upstream work this decision depends on; per the issue, Flux is **not installed** here — this ADR records the analysis and the trigger.

## Options

### A. Adopt now

Flux (source/kustomize/helm/notification controllers) pulls this repo and reconciles every base. Wins: merge-to-deployed for **all** manifests (today only `deploy/factory/base` auto-applies), continuous drift correction + prune cluster-wide, HelmReleases with postRenderers could absorb the tailscale chart's `PROXY_TAGS` workaround and bring ESO into git. Costs: +4 controllers and CRDs as a recovery dependency; `flux bootstrap` needs a GitHub credential with repo scope on a dead-disk rebuild; debugging moves through new CRDs (`Kustomization`, `HelmRelease` status conditions) instead of `kubectl diff`; prune is dangerous on a cluster that deliberately runs out-of-band things (hermes-created Jobs, serve-fixer state).

### B. Defer (chosen)

Keep root Kustomize + the rebuild script path. The two drift vectors observed in practice (stale images, factory manifests) are already covered by automations costing ~40Mi and a few CronJob minutes per hour. Revisit on the quantified triggers in D7.

### C. Reject outright

Remove even the possibility — e.g. freeze the reconciler pattern as permanent policy. Rejected: the factory (ADR-001) is explicitly building toward unattended agent-generated merges, and Helm-managed operators are accumulating (tailscale, ESO). At some merge rate, "human runs `kubectl apply`" becomes the bottleneck; a permanent rejection would force a worse choice later.

## Decisions

### D1. Dead-disk recovery, both approaches

| Step | Plain Kustomize (today) | With Flux |
| --- | --- | --- |
| OS + k3s + tailscale | `bootstrap/bootstrap.sh` | same |
| CD system install | — | `flux bootstrap github` (needs a PAT/deploy key with repo scope, ~2 min, downloads controllers) |
| Hand-entered secrets | 1Password service-account token (env/stdin) | same, **plus** Flux's own git credential |
| Apply manifests | ~10 `kubectl apply -k` lines in a fixed order | one root `Kustomization`; Flux reconciles |
| Verify | `scripts/rebuild-check.sh` | same + `flux get kustomizations` |

Net: Flux replaces ten apply lines with one bootstrap command but adds the flux-system namespace, its CRDs, and a second credential to the recovery path. Total recovery time is roughly unchanged (~15 min today; k3s install and image pulls dominate, not applies). If #34 shows applies are _not_ the slow part of recovery — the expected result — Flux buys nothing for the dead-disk scenario.

### D2. External Secrets and the one bootstrap token

The secret model is identical under both options: exactly one hand-entered value, the least-privilege 1Password service-account token (issue #41), after which ESO syncs `github-token`/`github-token-writer`/`backup-target` from the vault. Flux never manages secret _values_ — it would only apply the ExternalSecret manifests that already exist in `deploy/github-tokens/base`. Order matters under Flux too: flux → ESO → token secret → ExternalSecrets sync. Flux's additions are its own git credential (bootstrap key/PAT) and, if image automation is ever used, a write-scoped token — both are _new_ credentials the current model doesn't need.

### D3. Steady-state resource estimate (8 GB node, actual workloads)

Estimate for a minimal install (source + kustomize + helm + notification controllers), to be replaced by measurement before any adoption:

- Memory: ~300–500 Mi combined RSS (source ~100 Mi, kustomize ~100–130 Mi, helm ~60–90 Mi, notification ~40–60 Mi) — **~4–6% of one node's RAM**, permanently.
- CPU: mostly idle; periodic git/registry polls put it at ~1–3% of a core, worse during reconciliation storms — comparable to k3s's own controller overhead.
- What it displaces: auto-deploy (32 Mi) + factory reconciler (short Jobs). Net cost ≈ +300–450 Mi.

Measurement procedure for the actual hardware (run during any trial install, before deciding): apply Flux, let the cluster settle 24 h, then on agent-1:

```sh
kubectl top pods -n flux-system --sum
kubectl get pods -n flux-system -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].resources}{"\n"}{end}'
```

Recorded results: **not yet measured — no trial install performed (this issue installs nothing)**

### D4. Drift correction: what each layer actually fixes

Observed drift classes and their current remedy:

| Drift | Today | Flux |
| --- | --- | --- |
| Stale image after CI push | auto-deploy watcher | absorbed (merge → sync) |
| `deploy/factory/base` drift | reconciler CronJob | absorbed |
| Manifest drift elsewhere (manual edits, partial applies) | `rebuild-check.sh` detects; human fixes | auto-corrected continuously + pruned |
| Tailscale `PROXY_TAGS` env pin | documented `kubectl set env` workaround | absorbable via HelmRelease postRenderer — genuine win |
| Tailscale serve entries pointing at dead pod IPs | serve-fixer loop (calls Tailscale API, not k8s) | **not fixed** — out-of-band API state |
| Hermes gateway process dead inside pod | probe/restart config | **not fixed** — in-pod state |
| Hand-made files in PVCs (sidecar `.mjs`) | initContainer copy | **not fixed** — volume state |

Roughly a third of the 2026-08-25 audit's gaps are invisible to Flux; the runbook stays regardless.

### D5. Helm operators

One helm-managed workload today (tailscale-operator) plus ESO installed out-of-band. Flux would pull both into git as HelmReleases — real, but manageable by extending the rebuild runbook instead. helm-controller is also the largest chunk of the adoption cost (D3); deferring it while only two charts exist is cheap.

### D6. Agent PR merge ⇒ automatic deployment?

Yes in principle, and this is the strongest future argument for Flux: ADR-001 D7 already gates merge on human review + CI, so "merge implies deploy" keeps the human in the loop while removing the manual apply. Today it would be premature: factory PRs are drafts awaiting review and merge throughput is human-limited, so deployment is not the bottleneck — and the existing automations already cover the two highest-frequency change classes. The decision to wire it stays open until the triggers below fire.

### D7. Revisit trigger (quantified)

Install Flux when **#34 passes** (teardown→bring-up with zero out-of-band fixes) **and** any one of:

1. Merged agent PRs average ≥ 5/week for 4 consecutive weeks, or the factory reaches `reviewed → merged` without a human in the loop;
2. A third helm-managed operator lands (per D5, the break-even for helm-controller);
3. A drift incident outside `deploy/factory/base` causes an outage that continuous reconciliation would have prevented;
4. Rebuild timing shows manifest applies (not OS/k3s/image pulls) are a meaningful fraction of recovery time.

Until then: root Kustomize, `scripts/rebuild-check.sh` after any manual change, and the two existing automations.

## Consequences

- No new controllers, CRDs, or credentials now; the recovery path stays exactly as documented in docs/rebuild-runbook.md.
- Manifest changes outside `deploy/factory/base` still need a manual `kubectl apply` after merge — accepted, and listed as trigger D7-1 when it stops being acceptable.
- The two partial automations (auto-deploy, reconciler) remain the in-house stand-ins; if either grows a second feature, that is a signal to re-read this ADR.
- D3's measurement table must be filled from real hardware before option A is ever chosen; the estimates above are planning figures, not evidence.
