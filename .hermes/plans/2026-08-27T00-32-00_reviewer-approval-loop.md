# Factory Reviewer / Approval Loop Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop draft PRs from piling up — add a harness-agnostic, GitHub-as-ledger reviewer/approval loop that turns `factory/draft-pr` into `merge → release → shipped` with human approval and optional auto-promote, visible in the panel.

**Architecture:** Extend ADR-002 without a DB. Keep GitHub labels + PR states as the state machine. Add a thin `factory-reviewer` CronJob (same pattern as `factory-orchestrator`/`factory-security`) that polls `factory/draft-pr`, checks CI + review status, nudges, and auto-promotes when `approved + CI green`. Panel gets a new `Review Queue` card (`GET /api/factory/prs`, `POST /api/factory/review|merge`) so you can approve/merge from `panel.tailc3cc03.ts.net` instead of hunting GitHub. No harness lock-in — reviewer works for `code-pr` and `security` PRs.

**Tech Stack:** `apps/factory/reviewer` (sh-only, `gh` + `jq`, `ghcr.io/gwkline/homelab/factory/reviewer`), `deploy/factory/base/{reviewer-cronjob,profile-reviewer}.yaml`, `apps/panel/server/index.ts` (Hono + `k8sFetch` with CA), `apps/panel/web/src/App.tsx` (React + `lucide-react`), existing `factory-security`/`code-pr` publisher untouched.

---

## Current Context / Assumptions

- Ledger today: `factory/queued → in-progress → draft-pr | failed` per `docs/factory-v1-github-ledger.md`. 6 open draft PRs in `gwkline/launchpad` (`#14,13,12,11,10,8`, all `isDraft:true`, no labels), 1 open `feat/factory-security` PR in `homelab`. Issues retain `factory/draft-pr` after publish; PR body `Closes #N` will auto-close the linked issue on merge but labels are not cleaned.
- Publisher already does: `branch factory/issue-N/<profile> → git apply → commit → push → gh pr create --draft`. Branch `factory/issue-N/<profile>` is the dedupe key (`run.sh:58-64`).
- Panel (`apps/panel/server/index.ts:90-157 POST /api/factory/run`) already injects `FACTORY_ISSUE + FACTORY_PROFILE` to avoid GH label-propagation race; recent `ts-panel` ingress proxy fixed to `10.42.0.119`.
- `deploy/factory/base` kustomize yields 2 CronJobs (`factory-orchestrator 0 */6`, `factory-security 0 4 suspend:true`), CI matrix now 7 apps, `verify.sh` gates on `shellcheck -S error`.
- Operator wants slow drip (4/day), self-maintaining, no Postgres, harness-agnostic (no opencode lock). Tailscale ingress is the only panel auth today (tailnet + `NetworkPolicy allow-tailscale-to-panel`).
- Risk: `gh pr list` needs `repo` scope; `GITHUB_TOKEN` currently has `repo, workflow` (fine). No `CODEOWNERS` yet.

## Proposed Approach

**State machine extension (no new infra):**

```
factory/draft-pr  (publisher just created draft PR)
  ↓  reviewer observes: CI pending → comment "CI ⏳"
  ↓  CI green → add factory/needs-review (or reuse draft-pr + PR review-requested), comment "@owner review?"
factory/needs-review  (PR isDraft=false or review requested, CI green)
  ↓  human approves (GitHub review or panel POST /api/factory/review {approve:true})
  ↓  reviewer observes: approved + CI green → comment "✅ ready to merge", optionally auto-merge after quiet window
factory/approved → merged → factory/shipped (or label removed, issue closed via Closes #N)
factory/failed  (CI red / review changes-requested → stays, nudge)
```

- Labels are the source of truth; PR `isDraft`, `reviewDecision`, `statusCheckRollup` are derived. No DB.
- **Phase 1 (this plan):** Panel visibility + manual approve/merge. No auto-merge yet.
- **Phase 2 (follow-up):** CronJob auto-promotes after `approved + CI green` + optional `auto-merge` window (e.g. 30 min quiet). Disabled by default (`suspend:true`) until you opt-in.

**Why a CronJob, not GitHub Action:** Keeps reviewer in-cluster, same `ghcr.io` signing, same Tailscale auth, retries via `Forbid`/`activeDeadlineSeconds`, and reuses `github-token` mount. A GH Action could also do it, but cluster reviewer can `kubectl` + reuse panel's `ghToken()` pattern and stays harness-agnostic.

**Files likely to change**

- Create: `apps/factory/reviewer/Dockerfile`, `apps/factory/reviewer/run-reviewer.sh`, `deploy/factory/base/profile-reviewer.yaml`, `deploy/factory/base/reviewer-cronjob.yaml`, `apps/factory/reviewer/README.md`
- Modify: `deploy/factory/base/kustomization.yaml:resources`, `.github/workflows/ci.yaml:matrix.include`, `scripts/verify.sh` (add `apps/factory/**/run-reviewer.sh`), `apps/panel/server/index.ts` (+ `GET /api/factory/prs`, `POST /api/factory/review`, `POST /api/factory/merge`, optional `auth` guard parity), `apps/panel/web/src/App.tsx` (+ Review Queue card, approve/merge buttons), `docs/factory-v1-github-ledger.md` (state diagram)
- Test: `apps/panel/tests/panel.test.mjs` (+ factory prs mock), new `apps/factory/reviewer/tests/review.test.sh` or `panel` server unit

---

### Task 1: Document the reviewer state & API contract

**Objective:** Nail the label transitions and panel API shapes before code so implementers have a spec to test against.

**Files:**
- Modify: `docs/factory-v1-github-ledger.md:28-42` (add `needs-review`, `approved`, `shipped` rows + `PR isDraft/reviewDecision` mapping)
- Create: `.hermes/plans/2026-08-27_reviewer-contract.md` (temporary, merged into doc)

**Step 1: Write failing doc test**

Run: `grep -c "needs-review" docs/factory-v1-github-ledger.md`
Expected: `0` (fails — doc doesn't yet describe reviewer)

**Step 2: Add state rows**

```markdown
| needs-review | `factory/needs-review` | PR draft→ready or reviewRequested, CI green, awaiting human |
| approved     | `factory/approved`     | PR approved (`APPROVED`), CI green |
| shipped      | `factory/shipped` (or label removed + issue closed) | PR merged |
```

Also note: `factory/draft-pr` remains until merge; reviewer adds `factory/needs-review` when `isDraft:false` or `reviewRequested`.

**Step 3: Define API contract**

```
GET  /api/factory/prs?repo=gwkline/launchpad → {repo, prs:[{number, title, headRef, url, isDraft, reviewDecision, state, checks:{state, conclusion}, labels, linkedIssue}]}
POST /api/factory/review {repo, pr, event:"APPROVE"|"REQUEST_CHANGES", body?} → gh pr review
POST /api/factory/merge  {repo, pr, strategy:"squash"|"merge"|"rebase"} → gh pr merge --squash --auto? (manual first)
```

**Step 4: Verify**

Run: `grep -c "needs-review" docs/factory-v1-github-ledger.md`
Expected: `>=1` PASS

**Step 5: Commit**

```bash
git add docs/factory-v1-github-ledger.md
git commit -m "docs(factory): extend ledger with needs-review/approved/shipped"
```

---

### Task 2: Scaffold `factory-reviewer` image (harness-agnostic)

**Objective:** Create the reviewer worker image that can poll GH and act, without any LLM.

**Files:**
- Create: `apps/factory/reviewer/Dockerfile`
- Create: `apps/factory/reviewer/run-reviewer.sh` (stub, `echo not yet`)
- Modify: `.github/workflows/ci.yaml:30-41` (add `- app: factory/reviewer`)

**Step 1: Failing build test**

Run: `docker build -f apps/factory/reviewer/Dockerfile . 2>&1 | tail -5`
Expected: FAIL — file missing

**Step 2: Minimal Dockerfile (reuse orchestrator base, not worker)**

```dockerfile
# Factory reviewer — GitHub-as-ledger poller, no model API.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq git python3 openssh-client \
 && rm -rf /var/lib/apt/lists/*
ARG GH_VERSION=2.62.0
RUN ARCH=$(dpkg --print-architecture) \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" | tar -xz -C /tmp --strip-components=1 \
 && install -m755 /tmp/bin/gh /usr/local/bin/gh && rm -rf /tmp
ARG KUBECTL_VERSION=1.31.3
RUN curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl
WORKDIR /reviewer
COPY apps/factory/reviewer/run-reviewer.sh /reviewer/run-reviewer.sh
RUN chmod +x /reviewer/run-reviewer.sh
ENTRYPOINT ["/reviewer/run-reviewer.sh"]
```

**Step 3: Verify**

Run: `docker build -f apps/factory/reviewer/Dockerfile -t ghcr.io/gwkline/homelab/factory/reviewer:test . 2>&1 | tail -10; echo $?`
Expected: `0` (image builds, run-reviewer.sh is stub)

Run: `grep -c "factory/reviewer" .github/workflows/ci.yaml`
Expected: `1`

**Step 4: Commit**

```bash
git add apps/factory/reviewer/Dockerfile apps/factory/reviewer/run-reviewer.sh .github/workflows/ci.yaml
git commit -m "feat(factory): scaffold reviewer image (harness-agnostic)"
```

---

### Task 3: Implement `run-reviewer.sh` — poll, check, nudge (read-only v1)

**Objective:** Read-only reviewer that never mutates PRs yet — just observes and comments so you can see the loop working before enabling writes.

**Files:**
- Modify: `apps/factory/reviewer/run-reviewer.sh:1-260`

**Step 1: Failing behavior test**

Create `apps/factory/reviewer/tests/review.test.sh`:
```bash
#!/bin/bash
set -e
# stub gh for offline test
gh() { case "$*" in *"pr list"*) echo '[{"number":8,"isDraft":true,"reviewDecision":null}]';; *) echo '{}';; esac; }
export -f gh
./apps/factory/reviewer/run-reviewer.sh; test $? -eq 0
```
Run: `bash apps/factory/reviewer/tests/review.test.sh`
Expected: FAIL — script not yet polling `factory/draft-pr`

**Step 2: Implement read-only poll**

Key logic (sh, no LLM):
```sh
#!/bin/sh
set -eu
REPO="${FACTORY_REPO:?required}"
gh auth status >/dev/null 2>&1 || exit 1
# 1. list issues with factory/draft-pr or factory/needs-review
QUEUED=$(gh api "repos/${REPO}/issues?labels=factory/draft-pr&state=open&per_page=20" --jq '.[].number')
for NUM in $QUEUED; do
  PR=$(gh pr list -R "$REPO" --search "head:factory/issue-${NUM}/" --json number,isDraft,reviewDecision,statusCheckRollup --jq '.[0]')
  echo "[reviewer] issue #$NUM → $PR"
  # 2. if isDraft && checks success → suggest readyForReview
  # 3. if reviewDecision==APPROVED && checks success → suggest merge
  # v1: only echo + post a single idempotent comment (marker <!-- factory:review:N -->)
done
echo "[reviewer] done"
```

**Step 3: Verify**

Run: `shellcheck apps/factory/reviewer/run-reviewer.sh` → PASS (add to `scripts/verify.sh` glob)
Run: `bash apps/factory/reviewer/tests/review.test.sh` → PASS

**Step 4: Commit**

```bash
git add apps/factory/reviewer/run-reviewer.sh
git commit -m "feat(factory): reviewer polls draft-pr and reports status (read-only)"
```

---

### Task 4: Add K8s wiring — profile, CronJob, kustomize

**Objective:** Make `factory-reviewer` schedulable alongside `factory-orchestrator`/`factory-security` without privilege creep.

**Files:**
- Create: `deploy/factory/base/profile-reviewer.yaml` (ConfigMap `factory-profile-reviewer` + `NetworkPolicy allow-factory-reviewer` (github.com + ghcr + DNS only) + `ServiceAccount factory-reviewer automount:false`)
- Create: `deploy/factory/base/reviewer-cronjob.yaml` (`CronJob factory-reviewer`, `schedule: "0 */12 * * *"` (2/day, after `factory-security 0 4`), `Forbid`, `suspend:true` initially, `serviceAccountName: factory-reviewer`, `readOnlyRootFilesystem:true`, `resources 100m/128Mi`, env `FACTORY_REPO=gwkline/launchpad`, `GH_TOKEN` from `github-token`)
- Modify: `deploy/factory/base/kustomization.yaml:resources` (add both)
- Modify: `scripts/verify.sh` (add `apps/factory/**/run-reviewer.sh` to shellcheck)

**Step 1: Failing kustomize test**

Run: `kubectl kustomize deploy/factory/base 2>&1 | grep -c "factory-reviewer"`
Expected: `0`

**Step 2: Add files (copy `security-cronjob.yaml` structure, swap `security → reviewer`, image `ghcr.io/gwkline/homelab/factory/reviewer:latest`)**

**Step 3: Verify**

Run: `kubectl kustomize deploy/factory/base 2>&1 | grep -E "kind:|name: factory-"` → should show `factory-orchestrator`, `factory-security`, `factory-reviewer` (3 CronJobs)
Run: `./scripts/verify.sh` → `ALL CHECKS PASSED`

**Step 4: Commit**

```bash
git add deploy/factory/base/profile-reviewer.yaml deploy/factory/base/reviewer-cronjob.yaml deploy/factory/base/kustomization.yaml scripts/verify.sh
git commit -m "feat(factory): wire reviewer CronJob and profile (kustomize)"
```

---

### Task 5: Panel server — `GET /api/factory/prs` (read-only queue)

**Objective:** Panel can list PRs that are `factory/draft-pr` with live CI + review status, so you see what's stuck.

**Files:**
- Modify: `apps/panel/server/index.ts:70-89` (add new endpoint after `/api/factory/issues`)
- Modify: `apps/panel/tests/panel.test.mjs` (mock new endpoint)

**Step 1: Failing test**

Add to `panel.test.mjs`:
```js
const r = await fetch(`http://127.0.0.1:${port}/api/factory/prs?repo=gwkline/launchpad`);
assert.equal(r.status, 200);
const j = await r.json();
assert.ok(Array.isArray(j.prs));
```
Run: `node --test apps/panel/tests/panel.test.mjs`
Expected: FAIL — 404

**Step 2: Implement endpoint**

```ts
app.get("/api/factory/prs", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) return c.json({error:...},400);
  const prs = await ghFetch(`/repos/${repo}/pulls?state=open&per_page=50`); // filter head factory/issue-*
  // enrich each with gh pr view --json isDraft,reviewDecision,statusCheckRollup via gh api /pulls/N
  // or GET /repos/${repo}/pulls/${n}/reviews + /commits/N/check-runs
  return c.json({repo, prs});
});
```

Use `ghFetch` (already has token + error mapping) + parallel `Promise.all`.

**Step 3: Verify**

Run: `node --test apps/panel/tests/panel.test.mjs` → PASS
Run: `curl http://127.0.0.1:18082/api/factory/prs?repo=gwkline/launchpad | jq .prs[0]` → shows PR #8 etc with `isDraft`, `reviewDecision`

**Step 4: Commit**

```bash
git add apps/panel/server/index.ts apps/panel/tests/panel.test.mjs
git commit -m "feat(panel): GET /api/factory/prs — review queue (read-only)"
```

---

### Task 6: Panel server — `POST /api/factory/review` + `/merge` (write path, guarded)

**Objective:** One-click approve / request-changes / merge from the panel, reusing the same tailnet trust model as `POST /api/factory/run`.

**Files:**
- Modify: `apps/panel/server/index.ts:159-200` (add two POST handlers)

**Step 1: Failing test**

```js
const r = await fetch(`.../api/factory/review`, {method:"POST", body:JSON.stringify({repo, pr:8, event:"APPROVE"})});
assert.equal(r.status, 200);
```
Expected: 404

**Step 2: Implement (with profile allowlist parity)**

```ts
app.post("/api/factory/review", async (c) => {
  const {repo, pr, event, body} = await c.req.json();
  // validate repo ∈ FACTORY_REPOS, pr ∈ [1,1e6], event ∈ {APPROVE, REQUEST_CHANGES, COMMENT}
  // ghFetch POST /repos/${repo}/pulls/${pr}/reviews {event, body}
});
app.post("/api/factory/merge", async (c) => {
  const {repo, pr, strategy} = await c.req.json();
  // strategy ∈ {squash, merge, rebase}, default squash
  // check pr via GET /pulls/${pr} → must be isDraft==false or ready, reviewDecision==APPROVED, statusCheckRollup success
  // then ghFetch PUT /repos/${repo}/pulls/${pr}/merge {merge_method, commit_title}
});
```

Add guard: `pr` must be `factory/issue-*/` head (prevent merging arbitrary PRs).

**Step 3: Verify**

Run: `node --test apps/panel/tests/panel.test.mjs` → PASS
Live smoke (port-forward 18082):
```bash
curl -X POST http://127.0.0.1:18082/api/factory/review -H 'content-type: application/json' -d '{"repo":"gwkline/launchpad","pr":8,"event":"APPROVE","body":"LGTM via panel"}'
# expect 200 {review_id}
```

**Step 4: Commit**

```bash
git add apps/panel/server/index.ts
git commit -m "feat(panel): approve/merge PRs from review queue"
```

---

### Task 7: Panel web — Review Queue card

**Objective:** Show the 6 stale drafts and let you approve/merge without leaving `panel.tailc3cc03.ts.net`.

**Files:**
- Modify: `apps/panel/web/src/App.tsx:130-180` (new `<Card title="review queue">` between Factory and `launch a run`)
- Modify: `apps/panel/web/src/components/ui.tsx` (optional `Button variant="ghost"` for approve)

**Step 1: Failing visual test**

Run: `npm --prefix apps/panel run build` → works, but UI has no "review queue" string.
```bash
grep -q "review queue" apps/panel/web/src/App.tsx || exit 1
```
Expected: FAIL

**Step 2: Implement card**

- Fetch `GET /api/factory/prs?repo=${factoryRepo}` on mount + every 30s.
- For each PR: show `#N title · factory/issue-N/code-pr · draft? · reviewDecision · checks` with `Badge` colors (green `APPROVED`, yellow `CHANGES_REQUESTED`, gray `draft`).
- Buttons: `Approve` (→ `POST /api/factory/review APPROVE`), `Request changes`, `Ready for review` (if `isDraft`), `Merge (squash)` (enabled only if `APPROVED + checks success`).
- After action, re-fetch queue + `refresh()`.

Re-use `FactoryIssue` fetch pattern (`useEffect` + `setInterval`).

**Step 3: Verify**

Run: `npm --prefix apps/panel run build` → `assets/index-*.js` built.
Manual: `http://127.0.0.1:18082` (port-forward `agents/deployment/panel 18082:3000`) shows queue with PR #8 etc.

**Step 4: Commit**

```bash
git add apps/panel/web/src/App.tsx apps/panel/web/src/components/ui.tsx
git commit -m "feat(panel): review queue card — approve/merge drafts"
```

---

### Task 8: Promote read-only reviewer to nudger (optional, behind flag)

**Objective:** When you opt-in, `factory-reviewer` stops being read-only and posts idempotent comments + flips labels: `draft-pr → needs-review → approved → merge`.

**Files:**
- Modify: `apps/factory/reviewer/run-reviewer.sh:1-100` (add write branch, guarded by `FACTORY_REVIEWER_AUTO_MERGE=false` env)

**Step 1: Add env gate**

In `reviewer-cronjob.yaml:env` add `- name: FACTORY_REVIEWER_AUTO_MERGE value: "false"` (default off).

**Step 2: Write logic**

```sh
if [ "${FACTORY_REVIEWER_AUTO_MERGE}" = "true" ]; then
  # if checks success + reviewDecision APPROVED → gh pr merge --squash --delete-branch
  # else if isDraft && checks success → gh pr ready
  # else comment with marker <!-- factory:review:N:TS --> (upsert, not duplicate)
fi
```

Respect branch protection: `gh pr merge` will fail if `reviewDecision != APPROVED` or checks red — surface as comment, not force.

**Step 3: Verify**

Dry-run: `FACTORY_REVIEWER_AUTO_MERGE=false ./apps/factory/reviewer/run-reviewer.sh` → only echoes, no `gh pr merge`.
Enable: set env true + `gh pr list --json reviewDecision` returns `APPROVED` → `gh pr merge` called.

**Step 4: Commit**

```bash
git add apps/factory/reviewer/run-reviewer.sh deploy/factory/base/reviewer-cronjob.yaml
git commit -m "feat(factory): reviewer auto-promote behind flag (off by default)"
```

---

### Task 9: E2E validation & release

**Objective:** Prove the loop closes: `factory/queued → draft-pr → needs-review → approved → merged → shipped` for one real issue.

**Files:**
- None (validation only) — optionally `docs/factory-v1-github-ledger.md` final note

**Step 1: Pick a candidate**

Use `gwkline/launchpad#3` (enhancement, no draft yet) — or create a fresh `test: reviewer e2e` issue labeled `factory/queued`.

**Step 2: Manual run via panel**

1. `panel.tailc3cc03.ts.net` → Factory card → `run security` (or `code-pr`) on `#3`
2. Wait for draft PR → Review Queue shows `draft, checks pending`
3. `Ready for review` → `Approve` → `Merge (squash)` (or GitHub approve)
4. Verify `gh pr list --state open | grep factory/issue-3` gone, `gh issue view 3 --json state` == `CLOSED`, `git log --oneline origin/main` shows merge commit.

**Step 3: Kustomize + verify + CI**

Run: `./scripts/verify.sh` → `ALL CHECKS PASSED`
Run: `kubectl kustomize deploy/factory/base | grep -E "kind:|name: factory-"` → 3 CronJobs visible

PR: `feat(factory): reviewer/approval loop` → CI `validate + build (factory/reviewer, panel, factory/*)` green → `gh pr merge --squash --admin` (branch protection as before).

**Step 4: Unsuspend**

```bash
kubectl --kubeconfig ~/kubeconfig-homelab patch cronjob factory-reviewer -n sandbox -p '{"spec":{"suspend":false}}'
kubectl --kubeconfig ~/kubeconfig-homelab patch cronjob factory-security  -n sandbox -p '{"spec":{"suspend":false}}' # if you want nightly security sweep too
```

---

## Tests / Validation

- `scripts/verify.sh` after every task — **must** be `ALL CHECKS PASSED` (covers `shellcheck -S error`, `kustomize`, secret pattern, image owner).
- `node --test apps/panel/tests/panel.test.mjs` — add cases for `/api/factory/prs`, `/review`, `/merge` (mock `ghFetch`).
- `shellcheck apps/factory/reviewer/run-reviewer.sh` — `SC2148` shebang required.
- Live smoke via `kubectl port-forward -n agents deployment/panel 18082:3000` → `curl http://127.0.0.1:18082/api/factory/prs?repo=gwkline/launchpad | jq`.
- Kustomize: `kubectl kustomize deploy/factory/base | grep "kind: CronJob"` → 3.

## Risks, Tradeoffs, Open Questions

- **Auto-merge risk:** Even with `APPROVED + CI green`, auto-merge without human eyes could ship a bad patch. Mitigation: keep auto-merge OFF by default; require explicit `approve` click (panel) or GH review. Later add quiet window (e.g. 15 min after approve with no new commits).
- **Tailscale auth:** Panel `POST /review|/merge` is tailnet-only, same as today. No extra auth in v1; if you want defense-in-depth, add `hono/bearerAuth` with a shared secret mounted at `/secrets/panel-auth` and check `X-Tailscale-User-Login` header.
- **Branch protection:** Should require `validate` job + 1 approval before merge. Not yet enforced — add `Settings → Branches → main → Require status checks + Require pull request reviews (1)` before enabling auto-merge, or `run-reviewer.sh` will fail `gh pr merge` with `405`.
- **Label churn:** Labels `factory/needs-review` vs reusing `factory/draft-pr`? Proposal introduces `needs-review` + `approved` + `shipped` to make the panel filter trivial; alternative is to derive solely from PR fields (`isDraft`, `reviewDecision`). Keep labels for now (consistent with ledger) but panel should tolerate either.
- **Rate & cost:** Reviewer polling `gh api` every 12h is ~20 calls/run — negligible (`5000/hr`). No LLM cost (reviewer is `gh` only).
- **Open question:** Should `security` PRs follow the same review queue or a separate `security/needs-review` lane with stricter reviewers? Proposal: same queue, but filter by `profile` label `factory.gwkline.io/profile`.

## Save Location

`.hermes/plans/2026-08-27T00-32-00_reviewer-approval-loop.md`
