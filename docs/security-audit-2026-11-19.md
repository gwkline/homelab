# Security and simplification audit — 2026-11-19

Read-only audit of the live k3s cluster (agent-1) plus the git source of truth, run 2026-11-19. Everything below was verified against the live cluster over kubectl (LAN API, bounded timeouts) and the repo at `0de2941`. Node-level claims that need root are labeled and listed as action items; they were not verified live.

Severity scale: **P0** = unacceptable data-loss or security exposure, fix now. **P1** = active security or operational gap with a known fix. **P2** = real risk or fragility, plan it. **P3** = hygiene, hardening, or cleanup.

## What is already good

The cluster earns most of its posture from design, not luck. Worth stating explicitly so the findings below are read as gaps in an otherwise strong baseline:

- **Tailnet-only exposure.** Every exposed service rides the Tailscale operator Ingress path (`*.<tailnet>`); there is no NodePort, no LoadBalancer, no public port. Plain HTTP is refused by design (verified: `http://` returns 000 on every host, HTTPS 200).
- **Durable proxy targets.** All seven `ts-*` serve configs point at the backend **Service ClusterIP**, not a pod IP (verified per proxy against live Service IPs). The old stale-pod-IP failure mode is gone, along with the serve-fixer sidecars that patched it.
- **Supply chain.** `ClusterImagePolicy homelab-images` enforces keyless sigstore signatures (GitHub Actions `ci.yaml@refs/heads/main` identity + Rekor transparency) for `ghcr.io/gwkline/homelab/**` in `enforce` mode, `no-match-policy: allow` is set explicitly, and the deployer dry-runs through admission before applying. No workload runs an unpinned or `:latest` image; every live image is digest-pinned.
- **Namespace hygiene.** PSA `restricted` enforce on `agents`, `sandbox`, `work`, `database`, `default`; `baseline` where operators need it; `policy.sigstore.dev/include` on the app namespaces. Netpol default-deny ingress in every app namespace with narrow per-app allows; `sandbox` and `work` egress is DNS + public internet only, with private ranges carved out.
- **RBAC.** No app ServiceAccount holds cluster-admin or write-all. Deployer Roles are create/patch-scoped to named kinds without delete or escalate. Viewer roles (hermes, panel, t3code, headlamp, alloy) are read-only. `work-docker-watch` can `get` exactly one named pod.
- **Secrets.** One 1Password vault → ESO → cluster, with an accurate, human-readable inventory in `docs/secrets-inventory.md` as the contract. K3s secret encryption and API audit logging are configured in `bootstrap/`.
- **Docs.** The runbook, secrets inventory, node-storage policy, per-app READMEs, and the deployer README describe the live system as it actually is — rare, and the reason this audit could be mostly mechanical.

## Findings

### A1 — P0 (tracks #358, #53): there is no data backup, anywhere

**Evidence (live, 2026-11-19):**

- CNPG `Cluster/pg-primary`: `spec.backup` is `null`. `archive_mode=on` with `archive_timeout=5min` but **no archive destination** — WAL is produced and thrown away.
- No restic/velero/barman/borg binary on the node, no backup units or timers in systemd (`systemctl list-timers` shows only distro timers plus `work-docker-guard`), no backup CronJob in the cluster, no backup manifests in `deploy/`.
- The Postgres primary, hermes home, t3code state/worktrees, cloudbeaver, loki, victoriametrics, panel-stats and grafana data all live on **one local-path disk on one node**. `work` claims moved to a separate SSD (#470), but that SSD is in the same chassis on the same board.

**Impact:** agent-1's disk, a kernel panic during a postgres write, a bad CNPG operator rollout, or the documented `local-path` single-copy failure mode loses the knowledge DB, the hermes home, t3code agent state and every worktree — permanently. Git and 1Password cover code and credentials; nothing covers state. There is also no restore-test evidence, because there is nothing to restore from.

**Remediation:** filed as evidence on #358 (off-node backups) and #53 (CNPG WAL archiving + scheduled backups + PITR on B2, draft PR #322). The audit's position: with zero coverage today, this is the cluster's largest risk by a wide margin; the pieces (CNPG `ScheduledBackup` + barman to B2, plus a restic sidecar or node-level restic for the remaining PVCs) are already scoped. The Postgres apply in A2 should not be delayed on it, but the next postgres restart is also the natural moment to stand up the backup path.

### A2 — P1 (#487): Postgres 18.6 → 18.7 security release is pinned in git but not applied

**Evidence (live):** the primary runs `postgresql:18.6-202608310817-minimal-trixie` (Aug 31 build). `deploy/postgres` at main pins `18.7-202611122305` **and** `pgvector 0.8.6 → 0.8.7` — the `kubectl diff -k deploy/postgres/base` is exactly that bump. Postgres is not a deployer target, so the merge waits for a hand-apply, and none has happened.

**Impact:** PostgreSQL 18.7 (released 2026-11-12) fixes **52 security vulnerabilities**; the headline is CVE-2026-6460 (CVSS 8.8) — type confusion via `ALTER ... SET DATA TYPE` that lets any role that can create objects execute code as the postgres OS user, with a public write-up and PoC. The knowledge DB grants logins to the knowledge services, cloudbeaver's reader, and operator tooling; the `knowledge_owner` role can create objects. This is a real, reachable class, not hygiene.

**Remediation:** hand-apply `kubectl apply -k deploy/postgres/base` in a quiet window (single-node CNPG image swap ≈ 90 s DB outage; `primaryUpdateMethod: restart`). The bump is already fully expressed in git — three places (catalog, cluster image, transformer) were handled by the pin refresh. Separately, the **CNPG operator** itself is 1.30.1 vs upstream 1.30.2 (Renovate produced no PR); fold that bump into the same window, all three places per the runbook.

### A3 — P1 (#488): the deployer has been suspended since the work-SSD migration

**Evidence (live):** `CronJob/agents/deployer` `spec.suspend=true` (set out-of-band — the git manifest deliberately does not set it), `lastSuccessfulTime=2026-11-18T07:00:57Z`. The Nov 18 storage migration used the documented kill switch; the loops were resumed, the deployer was not. The kill-switch note in the deployer README says resume the deployer **first**.

Concrete drift while paused: the newest green `t3code` build `sha256:cc27c2bd…` (includes #472's pinned Docker CLI) is not running — live t3code and work-t3code are one build behind on `92124ab2…`; the deployer's own `ops` image is one build behind (`1a9664e4…` vs `6fcb4f0e…`). The Grafana rule `CronJob has not succeeded in two intervals` is explicitly silenced while suspended, so nothing pages about this.

**Impact:** every merge to main for the deployer's targets (factory, hermes, knowledge, panel, t3code, work-t3code) silently stops reaching the cluster. This is the cluster's single automated deployment path.

**Remediation:** resume with `kubectl -n agents patch cronjob deployer -p '{"spec":{"suspend":false}}'` (or `false` via the documented undo), after confirming the next pass's diff is the expected t3code/ops digest move; then `kubectl apply -k deploy/deployer/base` to pick up the new ops image. Not applied by this audit: resuming triggers production rollouts and needs an explicit go.

### A4 — P2 (#489): pending hand-apply backlog beyond the deployer's reach

The repo's own model is "deployer owns its targets; a human applies the rest". That human step has accumulated real drift, all verified by `kubectl diff -k`:

| Base | Live vs git |
| --- | --- |
| `deploy/postgres` | A2: PG 18.7 + pgvector 0.8.7 waiting |
| `deploy/cloudbeaver` | adds `CB_SERVER_NAME=homelab` and wires `CB_ADMIN_NAME`/`CB_ADMIN_PASSWORD` from Secret `cloudbeaver-admin`; live cloudbeaver predates the wiring |
| `deploy/work-docker-vm` | ConfigMap `work-docker-endpoint` live says `host: 192.168.1.2`, git says `127.0.0.1` — the KVM-guest cutover (#473/#474) is half-applied |
| `deploy/work-t3code` | git adds the `DOCKER_VM_HOST` env the new endpoint needs |
| `deploy/deployer` | self-image one build behind (also A3) |
| `deploy/executor` | exists in git, absent in the cluster entirely (tracked by #373) |

**Remediation:** one maintenance pass applying the outstanding bases in the order the work-docker README prescribes (RBAC/token, endpoint ConfigMap, netpol, then the deployer), closing #373 for executor at the same time or removing the base. The half-applied KVM endpoint is the fragile one: live work-t3code has no `DOCKER_VM_HOST` while its netpol and node units assume the new topology.

### A5 — P2 (#490): four ExternalSecrets fail sync while their consumers run on hand-created secrets

**Evidence (live):** `cloudbeaver-admin`, `grafana-admin` (agents), `operator-oauth` (tailscale), `github-app` (sandbox) are all `SecretSyncedError`. The underlying Secrets exist — hand-created or helm-created — and the workloads work. `docs/secrets-inventory.md` documents 1Password items (`cloudbeaver-admin`, `grafana-admin`, `tailscale-operator-oauth`, `factory-github-app`) that the store cannot currently find.

The documented ESO behavior makes this a trap rather than a stale red light: the moment those items appear, ESO's first successful sync **overwrites the working cluster Secret with the item's value** — auth breaks silently if they differ. Also part of the same contract drift: three hand-applied Secrets (`cloudbeaver-admin`, `grafana-ntfy`, `panel-auth`) carry `kubectl.kubernetes.io/last-applied-configuration`, i.e. a base64 copy of their own data in metadata, which the inventory's contract explicitly expects to be absent.

**Remediation (Gavin-owned for the vault side):** create the four 1Password items with values matching the live Secrets (or deliberately rotate: set the item, let ESO win, then verify each consumer's login), or delete the ExternalSecrets that will never be used (`github-app` is an optional fallback and the safest deletion). Re-apply the three annotated Secrets with server-side apply to strip the annotation.

### A6 — P2 (#491): node root filesystem at 83%, shared by everything but work

**Evidence (live):** `/dev/mapper/ubuntu--vg-ubuntu--lv` 90G/115G used (20G free, 83%). Non-work PVCs (postgres 20Gi, hermes 20Gi, t3code 20Gi+5Gi, loki 10Gi, victoriametrics 15Gi, cloudbeaver 1Gi, panel-stats 1Gi), container images, journals and kubelet logs all live here. Kubelet live config confirmed: image GC 70/50 (so GC is already active and can only reclaim images), eviction at `5%` available ≈ 5.7G. `docs/node-storage-policy.md` documents the constraint honestly but there is no headroom trend or alert for the PVC share of it.

**Remediation:** pick one: move postgres + the observability claims to the work SSD's spare capacity (or a second data disk), or add a disk-usage alert with a defined threshold (e.g. page at 90%) and a capacity plan. Do nothing and the first thing to break under growth is the audit's most-protected component (postgres eviction → knowledge + hermes + panel go NotReady).

### A7 — P2 (#492): tailscale-operator is stuck two chart versions back with a failed upgrade in its history

**Evidence (live):** `helm history tailscale-operator` shows revision 4 = **failed** upgrade to 1.104.7 on Nov 13 ("resource Deployment/tailscale/operator not ready") rolled back to revision 3 (1.102.3), which is what runs. The upgrade failure is consistent with the known 1.102.x chart bug where the working `PROXY_TAGS=tag:k8s-operator` fix lives in an out-of-band `kubectl set env`, so any values-driven upgrade fights live state. `scripts/recovery-drill.sh` already pins 1.104.7, so a future rebuild and the live cluster would diverge. The operator and proxy pods also run without an explicit securityContext (root, `allowPrivilegeEscalation` unset) — upstream chart default, fixable via values while repairing.

**Remediation:** capture the live operator Deployment env (`PROXY_TAGS`), then repair per the runbook pattern: `helm upgrade` with the env expressed in values (or uninstall/reinstall — CRDs and proxies survive), verify a proxy comes up and a tailnet URL still answers, and set a restricted securityContext in values at the same time.

### A8 — P2 (#484): k3s is three patch releases behind on 1.36 (evidence filed on #484)

Live: `v1.36.3+k3s1`. Upstream: **v1.36.6+k3s1** (plus 1.37.2 current). The skipped 1.36.5 alone contains "Reject anonymous access to supervisor router (spegel/pprof/metrics)", "Improve CA hash validation", and a grpc bump for CVE-2026-84445; 1.36.6 adds containerd 2.3.7 and x/net bumps. Node-level (sudo) → Gavin's maintenance window; tracked by #484 — the audit filed the specific version deltas as a comment there.

### A9 — P3 (#493): `tailscale` namespace has no NetworkPolicies

Every other namespace defaults to deny. The operator (strong tailnet authority: it can mint proxies) and seven proxy pods accept connections from any pod in the cluster; only `sandbox`/`work` egress rules protect them today. Add `default-deny` ingress to `tailscale` ns + an allow for the operator's own webhook/metrics and the proxies' health paths; the proxies' backends already have `allow-tailscale-to-*` rules from the other side.

### A10 — P3 (#494): two long-lived ServiceAccount token Secrets with no expiry

`agents/gavin-headlamp-token` (77d, headlamp login) and `agents/work-docker-watch-token` (23h, host watcher). Projected/bound tokens with `expirationSeconds` do the same job and expire. Migrate headlamp's login to a bound token; `work-docker-watch` is newer and documented as host-only — fine to migrate opportunistically.

### A11 — P3 (#495): `readOnlyRootFilesystem` is unset across the first-party app containers

hermes, panel, t3code, knowledge (both), work-t3code, grafana, headlamp, cloudbeaver all run with writable root filesystems (they already set other restricted-PSA fields, so this is the one missing flag). Each needs a per-app `emptyDir` for its writable paths before the flag can be set; PSA is already `restricted`, so nothing enforces it today. Worth one PR per app as they're touched anyway.

### A12 — P3 (#496): admin access hygiene (kubeconfig TLS + client skew)

- `~/kubeconfig-homelab` carries `insecure-skip-tls-verify: true` because the k3s serving cert lacks the tailnet-IP SAN — so the Mac's normal admin path never verifies the server. Fix at the node: add `tls-san: 100.80.29.99` in `bootstrap/k3s-config.yaml` (it already documents host-specific SANs) during the A8 window, then drop the skip from the kubeconfig and verify.
- Mac kubectl is `v1.33.9` against server `v1.36.3` — beyond the supported ±1 skew (kubectl warns on every invocation). One-line fix: `curl -LO dl.k8s.io/release/v1.36.6/bin/darwin/amd64/kubectl` or brew.

### A13 — P3 (#497): `factory-stats-snapshot` CronJob has never succeeded

First (and only) run on Nov 15 failed: `ECONNREFUSED 10.43.134.58:3000` calling `panel-http.agents.svc.cluster.local:3000/api/factory/stats/rollup`. The panel pod listens on both 3000/3001 and the Service maps them correctly, so the likely cause is the job pod's egress: its labels fall under `agents-egress-default` (DNS-only). Weekly cadence means the next failure lands Sunday. Fix by adding its `app` to the egress allow for panel (or running it with an existing allowed label), then verify the next run's Job goes green.

### A14 — P3 (#498): third-party image currency follow-ups

All third-party images were refreshed to current by #467 on Nov 14 and verified current today **except**: grafana `13.2.6` (13.3.1 is out — minor-line lag, no patch gap inside 13.2.x), and cloudbeaver `26.2.4` (upstream check inconclusive via GitHub API — dbeaver publishes releases off-API; listed as a coverage exception, verify at the next sweep). CNPG operator 1.30.2 is folded into A2. Nothing CVE-bearing was confirmed in either gap.

## Cluster service map

Namespaces: `agents` (first-party apps + observability), `database` (postgres), `cnpg-system`, `cosign-system` (admission), `external-secrets`, `tailscale` (operator + proxies), `sandbox` (factory + canaries), `work` (isolated employer runner), `kube-system`, `default` (empty).

| Namespace | Workload | Kind | Exposure | Storage |
| --- | --- | --- | --- | --- |
| agents | hermes-0 | StatefulSet | internal (+ gateway) | data-hermes-0 20Gi |
| agents | t3code-0 | StatefulSet | `t3code-0.<tailnet>` | data-t3code-0 20Gi + t3state 5Gi |
| agents | panel | Deployment | `panel.<tailnet>` | panel-stats 1Gi |
| agents | knowledge-ingest | Deployment | cluster-internal only | stateless → Postgres |
| agents | knowledge-retrieval | Deployment | `knowledge.<tailnet>` | stateless → Postgres |
| agents | grafana | Deployment | `grafana.<tailnet>` | none (emptyDir DB) |
| agents | headlamp | Deployment | `headlamp.<tailnet>` | none |
| agents | cloudbeaver-0 | StatefulSet | `cloudbeaver.<tailnet>` | workspace 1Gi |
| agents | loki-0 / victoriametrics-0 / alloy / kube-state-metrics | Dep/STS | internal (grafana reads) | loki 10Gi, VM 15Gi |
| agents | deployer (CronJob, **suspended**), factory-stats-snapshot (CronJob, failing) | CronJob | — | — |
| database | pg-primary-1 (CNPG) | Cluster | internal `:5432` (TLSv1.3-only) | pg-primary-1 20Gi |
| tailscale | operator + 7 `ts-*` proxies | Dep/STS | tailnet edge | — |
| sandbox | factory orchestrator/reviewer/security/collector/medic/reclaimer/sweeper, egress-canary (CronJobs) | CronJob | — | — |
| work | work-t3code-0 | StatefulSet | `work-t3code-0.<tailnet>` | data 20Gi + 60Gi SSD + t3state 5Gi + 40Gi SSD |
| cnpg-system / cosign-system / external-secrets | CNPG operator, policy-controller webhook, ESO | Deployments | webhooks only | — |

### Knowledge-base service map (for the KB-agent work, #480/#481)

The knowledge base that `gwkline/personal-knowledge` syncs into runs **in `agents`, not `personal`** — the `personal` namespace in #480 is planned future work; nothing exists there yet. The sibling worker building the KB agent should target today's facts:

- **Deployments** (both run image `ghcr.io/gwkline/homelab/knowledge`, digest `7867007b…`, = newest green build):
  - `knowledge-ingest` — queue API (`/v1/ingest`, `/v1/sources`, `/v1/sync-jobs`) + worker that fetches git sources/URLs, chunks, embeds, upserts. **Cluster-internal only.** Service `knowledge-ingest` ClusterIP **:3100**. Applies schema migrations on boot under a Postgres advisory lock.
  - `knowledge-retrieval` — `POST /v1/search` (BM25 + vector, RRF fusion, cited chunks) + passthrough to ingest. Exposed at `https://knowledge.<tailnet>` via the tailscale Ingress, which proxies to Service `knowledge-retrieval-http` ClusterIP **:3000**. `/healthz` and `/readyz` 200 (verified live; `/` 404s — it is an API, not a page). `/metrics` on retrieval includes `knowledge_embedding_model_mismatch_chunks`.
- **Auth:** bearer token from Secret `knowledge-api-token` (admin, all routes; ESO-synced from 1Password `knowledge-api-token`; the same Secret exists in `sandbox` for the factory). Optional read-only `knowledge-search-token` (`/v1/search` only) exists in the manifest but has no 1Password item yet, so retrieval currently accepts only the admin token.
- **Backing store:** CNPG cluster **`pg-primary`** in namespace `database`, database **`knowledge`**, managed owner role **`knowledge_owner`**; services `pg-primary-rw/-ro/-r` on :5432 (TLSv1.3-only). Extensions installed: **pgvector 0.8.6** and `pg_textsearch` (declared via the `Database` CR `pg-primary-knowledge`, `APPLIED=true`). Connections use `KNOWLEDGE_*_DATABASE_URL` from Secret `knowledge-db` (same 1Password item as the `pg-primary-knowledge-owner` basic-auth Secret — rotate both together).
- **Embeddings: not configured.** Ingest writes placeholder vectors tagged `fake/384`; retrieval answers BM25-only (`mode: bm25`) until `KNOWLEDGE_EMBEDDING_PROVIDER`/`_BASE_URL` are set and documents are re-embedded. A KB agent that wants semantic recall must solve this first.
- **Ops notes:** both Deployments go NotReady (`/readyz`) while Postgres is unreachable and self-recover. Pods are stateless (no PVCs) — **the knowledge DB's durability is entirely the pg-primary PVC**, which is exactly the A1/A2 exposure. Ingest jobs drop document text when finished and prune after 14 days except each source's latest sync/failure.

## Image currency (verified 2026-11-19)

| Image | Live | Upstream | Verdict |
| --- | --- | --- | --- |
| ghcr.io/gwkline/* (hermes, knowledge, panel, factory/*, ops) | newest green Nov-16 builds | — | current |
| ghcr.io/gwkline/t3code (incl. work runner) | `92124ab2` | `cc27c2bd` (Nov 18) | **behind — A3** |
| cloudnative-pg (operator) | 1.30.1 | 1.30.2 | **patch gap — A2** |
| cnpg postgres | 18.6 (Aug 31) | **18.7 (Nov 12, 52 CVEs)** | **security gap — A2** |
| k3s | v1.36.3+k3s1 | v1.36.6+k3s1 (1.37.2 stable) | **3 patches + minor — A8** |
| tailscale k8s-operator | chart 1.102.3 | 1.104.7 (chart pin in repo) | **failed upgrade — A7** |
| grafana | 13.2.6 | 13.3.1 | minor lag — A14 |
| loki / alloy / victoriametrics / headlamp / external-secrets / kube-state-metrics | 3.7.10 / 1.22.0 / 1.156.0 / 0.46.0 / 2.15.0 / 2.20.0 | same | current |
| dbeaver/cloudbeaver | 26.2.4 | unverifiable via API | coverage exception — A14 |

## Quick wins applied during this audit

Both verified by kubectl readback; neither touches a running workload:

1. **Removed the stale hermes credential copy** `/data/home/.hermes/.env` (a 93-byte file from the Aug 25 bring-up, containing a live `OPENROUTER_API_KEY`, mode 0644, unused since — the real config home is `/data/hermes/`). Readback confirms the file is gone and the real `.env` is untouched.
2. **Deleted 461 terminated pod objects older than 48h** (the Nov 7–8 churn incident's litter plus months of CronJob history). Readback: terminal-phase pods remaining ≈ 30, all recent (factory/egress evidence intentionally preserved).

Not applied (per the audit's safety rules, each is filed instead): resuming the deployer (A3), the postgres apply (A2), all hand-applies (A4), secret annotation cleanup (A5), netpol additions (A9), token migrations (A10).

## Coverage exceptions (verified limits of this audit)

- **Node-level, sudo-gated:** k3s/Ubuntu package currency (only distro timers inspected unprivileged), live verification of the secrets-encryption config and audit policy on disk, journald live settings. The bootstrap files exist in git; live state was not re-verified. Listed as Gavin action items with A8/A12.
- **Cloudbeaver upstream version:** dbeaver does not expose latest via the GitHub releases API; no conclusion drawn.
- **CVE depth:** image-level CVEs were assessed by version-delta against upstream release notes (per the standing sweep procedure), not by re-running a scanner image; no new scan was scheduled during a deployer suspension.
- **Nov 7–8 churn:** pod archaeology shows a ~23h instability window (hundreds of short-lived pods across grafana/panel/headlamp/knowledge, plus the failed policy-controller upgrade) that self-resolved; root cause was not reconstructed from retained events. The litter was cleaned (quick win 2); nothing ongoing was found.
