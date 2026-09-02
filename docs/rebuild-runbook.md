# Rebuild Runbook — timed fast-recovery drill

**Goal:** from a clean Ubuntu 24.04 machine (or a representative VM running the same scripts and manifests), rebuild the whole platform from Git plus documented external credentials/backups, and measure how long it actually takes.

**Current target: fast recovery on one physical machine — not HA.** The cluster is a single k3s server with node-bound local-path PVCs. Nothing here promises uptime through a host failure; the optimized metric is how quickly one operator can bring everything back. High availability is explicitly out of scope until fast recovery is boring (roadmap #94).

**Status:** drill procedure implemented (issue #34). First timed run pending — see [Drill log](#drill-log-actual-rto--rpo).

---

## 1. Prerequisites (documented sources only)

Everything the drill starts from must be in this list. If you reach for anything else — a file from the old node, a secret from a running pod, a config not written down — that is a drill finding: it becomes a runbook step or a follow-up issue before the next run.

- Clean Ubuntu 24.04 host **or a VM** (a VM drill is acceptable before wiping the physical host, but it must exercise these exact scripts and manifests), with OpenSSH installed per [runbook-server-cluster](runbook-server-cluster.md) §0–2.
- Physical host only: `nomodeset` in the kernel cmdline (§3 below) so headless reboots survive.
- This repo checked out on the machine or the driver box.
- `kubectl` and `helm` available where the drill runs (server runbook §4–5).
- Credentials, all from documented external sources (never from the old cluster):

| Credential | Source |
| --- | --- |
| 1Password service-account token (`OP_SERVICE_ACCOUNT_TOKEN`) | 1Password `homelab` vault — least-privilege SA token (issue #41); entered via env/stdin only |
| GitHub tokens | 1Password items `github-readonly` / `github-writer`; synced by `kubectl apply -k deploy/github-tokens/base` (issue #45) |
| Tailscale OAuth (`TS_CLIENT_ID` / `TS_CLIENT_SECRET`) | macOS Keychain `homelab-tailscale`; tag `tag:k8s-operator` must exist on the OAuth client ([deploy/tailscale/README.md](../deploy/tailscale/README.md)) |
| B2 restore credentials (`restic-backup` item) | 1Password `Homelab` vault: `RESTIC_REPOSITORY`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`, `RESTIC_PASSWORD` ([runbook-server-cluster](runbook-server-cluster.md) §11) |

No hidden state is copied from the existing cluster. The only crossers are the documented channels above plus the B2 restic repository.

## 2. Pinned versions used by the drill

| Component | Version | Where it is pinned |
| --- | --- | --- |
| k3s | `v1.36.4+k3s1` | `bootstrap/bootstrap.sh` default (`K3S_VERSION` overrides for deliberate upgrades; formal pin/verify/upgrade policy: issue #29) |
| Tailscale operator chart | `1.102.3` | `scripts/recovery-drill.sh` (`TS_CHART_VERSION`); the PROXY_TAGS workaround in [deploy/tailscale/README.md](../deploy/tailscale/README.md) is tested against this chart |
| tailscaled (host package) | latest stable via install.sh | **unpinned — known gap**, owned by issue #29 |

`bootstrap/bootstrap.sh` is the root node entry point; `scripts/recovery-drill.sh` is the root cluster entry point (it runs the documented apply order — until issue #20 replaces it with a root Kustomization, the script is that order's source of truth).

## 3. Node prerequisites (physical host only)

1. `/etc/default/grub`: `GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nomodeset"`
2. `sudo update-grub`, then verify: `sudo grep -c nomodeset /boot/grub/grub.cfg` → must be ≥1 (verify with sudo — a user-level grep showing 0 may just mean permission, but confirm before relying on headless reboots)
3. k3s running (`systemctl status k3s`), tailscale up.

## 4. Timed drill procedure

### Step 0 — node bootstrap (interactive; start the clock here)

Record the drill-start timestamp as your **first command** on the clean machine:

```sh
date +%s   # DRILL_START — this is the RTO start line
git clone https://github.com/gwkline/homelab.git && cd homelab
./bootstrap/bootstrap.sh server          # pins k3s per section 2
```

Fetch the kubeconfig to the driver (server runbook §4), confirm `kubectl get nodes` is Ready, and export the four credentials from section 1.

### Step 1 — cluster bring-up (timed, one command)

```sh
./scripts/recovery-drill.sh --from "$DRILL_START"
```

The script runs and times every stage — operator (pinned chart + PROXY_TAGS workaround), namespaces/policies, secrets (1Password SA token + github-tokens sync), workloads (t3code, hermes, loop-agent, homepage, panel, dispatcher, factory), pods-ready, HTTPS (serve-https + serve-refresh + curl checks for t3code-0 and panel), and the `scripts/rebuild-check.sh` smoke sweep — then prints per-stage times and the total RTO. A failed stage fails the drill; the fix must land as a runbook step or follow-up issue before the next attempt (known warnings it emits are listed in section 6).

### Step 2 — PVC state: restore from B2 or intentionally recreate

Decide per workload and record the choice in the drill log:

- **Restore from B2** (path of record): run the scratch-restore job from [runbook-server-cluster](runbook-server-cluster.md) §11 to prove the repository restores, note the **observed RPO** = age of the newest snapshot at restore time, then copy the restored trees back into the fresh t3code/hermes PVCs before agents start writing. Git repos inside agent homes re-clone anyway; what must survive is unpushed agent state and hermes memory.
- **Intentionally recreate**: t3code state (repos re-clone, pairing re-runs) and hermes gateway config re-entered by hand. Record it as a decision, not an accident — and as an RPO of "everything since last snapshot, discarded".

Either way the drill result states which workloads' state was restored, recreated, or deliberately dropped, plus the observed RPO.

### Step 3 — workload-level checks (manual by design)

- t3code: pairing URL from `kubectl logs t3code-0 -n agents | head` → pair from desktop/phone (inherently interactive).
- hermes: `kubectl exec -it hermes-0 -n agents -- hermes setup --portal` once on a fresh PVC, then `kubectl rollout restart statefulset hermes -n agents`; message it on its channels and get a sane reply.
- dispatcher: `kubectl -n sandbox get cronjob dispatch-watcher` exists and is scheduled (end-to-end issue→Job proof is issue #30, not this drill).
- panel/homepage: open both over HTTPS; links resolve.

### Step 4 — record

Fill one row in the drill log (section 5), convert every manual surprise (section 6), and update the target RTO (section 7).

## 5. Drill log (actual RTO / RPO)

RTO = wall-clock from the clean machine's first command (`DRILL_START`) to all section-4 checks green. Observed RPO = age of the newest B2 snapshot used for restore (or "n/a — recreated").

| Run | Date | Machine | RTO (total) | RTO (cluster phase) | Observed RPO | PVC decision | Follow-ups filed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| template | YYYY-MM-DD | bare / VM | mm:ss | mm:ss | hh:mm | restored / recreated | #… |

_(No completed runs yet — first timed drill pending. This table is the evidence base for section 7.)_

## 6. Manual interventions → runbook steps or follow-up issues

Rule: every undocumented step you perform during a drill becomes either a runbook step here or a follow-up issue before the next run. Known gaps going into the first drill:

| Finding | Disposition |
| --- | --- |
| External Secrets Operator is not installed by any manifest — `github-token` sync stays Pending on a fresh cluster (drill script warns) | follow-up: install pinned ESO — issue #38 |
| Host tailscaled not version-pinned | follow-up: issue #29 |
| Apply order lives in `scripts/recovery-drill.sh` instead of a root Kustomization | follow-up: issue #20 |
| hermes `hermes setup --portal` re-run after PVC recreation | runbook step (section 4, step 3) |
| t3code pairing from desktop/phone | runbook step (section 4, step 3); durable auth persistence tracked by issue #19 |
| API-level manifest validation before apply (invalid RoleBindings, missing SAs) | follow-up: issue #16 |

## 7. Target RTO

Evidence-based: after at least two clean, successful drill runs on the representative machine, set **target RTO = median of the clean runs × 1.5, rounded up to the next 5 minutes**, and record it here with the run numbers it came from. Every future drill reports against it; a drill exceeding the target reopens this section (either fix the slow stage or revise the target with new evidence).

**Current target RTO: not set — first two measured runs pending.**
