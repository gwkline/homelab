# HANDOFF: Software Factory (#85) — State as of 2026-08-27

**For:** next agent/engineer picking this up **Time to context:** ~10 min read. Everything below is verified live unless marked.

## What exists (all in gwkline/homelab, main branch)

```
apps/factory/
├── worker/            # ephemeral coding-worker image
│   ├── Dockerfile     # node24 + rust 1.98 + gh + codex/claude/opencode/cursor CLIs
│   └── entrypoint.sh  # /task/brief.json → clone → WORKER_CMD → /out/{patch.diff,report.json}
└── orchestrator/
    ├── Dockerfile     # debian-slim + kubectl + gh v2.62
    └── run.sh         # THE BUG IS HERE (see below)

deploy/factory/base/
├── profile-code-pr.yaml      # ConfigMap profile + NetworkPolicy (egress allowlist) + SA
├── orchestrator-cronjob.yaml # CronJob */5min — SUSPENDED (spec.suspend=true)
└── kustomization.yaml

Secrets (namespace sandbox):
- github-token           # PAT, works: private clone+push verified via API (push:true)
- factory-opencode-auth  # key=auth-b64 → opencode auth.json (openrouter + zen keys)

Cluster: CronJob factory-orchestrator in `sandbox`, currently SUSPENDED.
Test issue: gwkline/launchpad#6, label currently `factory/failed`.
CI note: push triggers are FLAKY — use `gh workflow run ci --ref main` after merges.
```

## Working ✅ (verified end-to-end individually)

1. Orchestrator cron fires, queries `repos/gwkline/launchpad/issues?labels=factory/queued`
2. Label swap queued→in-progress + marker comment (`<!-- factory:run:N:TS -->`)
3. Worker Job creation via heredoc manifest (single-quoted YAML for b64 fields)
4. **Private repo clone** — token injected via `CLONE_URL` env, worker strips creds from origin after
5. **opencode runs headless** — proven in-pod: `FACTORY-OK` reply via openrouter/glm-5.3-flash (debug pod oc-test4)
6. Failure convergence: worker error ⇒ label `factory/failed` + log-tail comment (b18cfb0)
7. Idempotency: branch `factory/issue-N/code-pr` exists ⇒ skip; PR dedupe by head branch

## The remaining bug 🐛 — last failure before handoff

**Symptom:** orchestrator tick "picked issue #6", spawned worker, worker ran `opencode run` which errored intermittently:

- sometimes `Cannot connect to API`
- sometimes model falls back to wrong provider ("big-pickle" default)
- sometimes works (`FACTORY-OK` succeeded twice in isolation)
- tick-spawned Job Pods exit 1 with EMPTY logs; isolated debug pods SUCCEED with identical env

**What we ruled out:**

- NetworkPolicy egress ✅ (openrouter.ai HTTP 200 tested from a labeled pod)
- Auth encoding ✅ (entrypoint normalizes raw-JSON vs base64)
- Env ordering ✅ (GH_TOKEN declared before CLONE_URL so $(...) expansion resolves)
- OOM ✅/⚠️ (fixed 4Gi→12Gi after a rust repo ballooned memory; not the current blocker)

**Most likely cause (untested):** environment drift between `kubectl run` debug pods and Job-spawned pods, OR opencode reading config state under /home/node that differs between paths. NOT root-caused — needs an interactive session.

**Debug recipe:**

```sh
TOKEN=$(kubectl get secret github-token -n sandbox -o jsonpath='{.data.token}' | base64 -d)
AUTHB64=$(kubectl get secret factory-opencode-auth -n sandbox -o jsonpath='{.data.auth-b64}')
kubectl apply -f- <<EOF
apiVersion: v1
kind: Pod
metadata: {name: dbg, namespace: sandbox,
           labels: {factory.gwkline.io/profile: code-pr}}
spec:
  serviceAccountName: factory-worker
  containers:
  - name: w
    image: ghcr.io/gwkline/homelab/factory/worker:latest
    env:
    - {name: OPENCODE_AUTH_B64, value: "$AUTHB64"}
    - {name: GH_TOKEN, value: "$TOKEN"}
    - {name: CLONE_URL, value: "https://x-access-token:$TOKEN@github.com/gwkline/launchpad.git"}
    - {name: FACTORY_REPO, value: "gwkline/launchpad"}
    - {name: WORKER_CMD, value: "opencode run"}
    command: ["sleep","3600"]
EOF
# then: kubectl exec -it dbg -n sandbox -- bash
# 1. sh /usr/local/bin/entrypoint   → watch which step fails
# 2. cd /work/repo && ls            → did clone work?
# 3. opencode run --model openrouter/z-ai/glm-5.3-flash "print hello"
```

**Known-bad pattern to avoid:** failure paths MUST remove `factory/in-progress` when adding `factory/failed`. Earlier version didn't → combined with repeated manual re-labeling this caused the spam loop Gavin saw. Fixed in b18cfb0.

## On resume (order matters)

1. Unsuspend: `kubectl patch cronjob factory-orchestrator -n sandbox -p '{"spec":{"suspend":false}}'`
2. Reset test issue labels on launchpad#6: remove all `factory/*` except add `factory/queued`
3. ONE tick: `kubectl create job --from=cronjob/factory-orchestrator factory-debug-N -n sandbox`
4. If PR appears on launchpad: done predicate of #85 nearly met (add panel view #80, then close)

## Design reference

`docs/factory-v1-github-ledger.md` = ADR-002 GitHub-as-ledger (no DB). Labels ARE the state machine:

| Label                 | Meaning                  |
| --------------------- | ------------------------ |
| `factory/queued`      | waiting for orchestrator |
| `factory/in-progress` | worker running           |
| `factory/draft-pr`    | published                |
| `factory/failed`      | failed                   |

Marker comment format is versioned by `<!-- factory:run:ISSUE:TS -->`.

## Operator preferences already baked in

- No Postgres/DB in v1 (GitHub = ledger); plain repos only: whitelist = homelab + launchpad
- Private repos in scope; current PAT acceptable until #70 (GitHub App)
- Draft PRs only, never auto-merge; CI + review gate required
- glm-5.3-flash as default brain everywhere (ox-alpha retired from Mac + Homelabby + crons)
