# work-t3code — isolated work code runner

A second t3code instance ([`deploy/t3code`](../t3code)) that runs **work repositories** on the homelab without exposing the personal stack. Same image, same UX (tailnet URL, browser pairing, coding CLIs), different namespace, different credential, different blast radius.

This repository is public, so it deliberately carries **no work identifiers**: no employer name, no org, no repo URLs. Everything specific lives in one 1Password item.

## Isolation contract

| Boundary | How |
| --- | --- |
| GitHub | The pod mounts **only** Secret `work-github-token`: a fine-grained PAT whose _Repository access_ is limited to the operator's selected work repositories (Contents + Pull requests read/write). It cannot read any personal repo. The personal tokens (`github-readonly`/`github-writer`) are not synced into `work` — no workload there can read them. |
| Repo list | The cloned repos ride in the same Secret (key `repos`, one URL per line), not a committed ConfigMap — the public repo stays free of work identifiers. |
| Network | The `work` namespace is default-deny ingress AND egress. Egress is DNS + public internet only — the Kubernetes API, LAN, tailnet, and every other homelab service are carved out (see `deploy/policies/base/networkpolicy.yaml`, `work-egress-public-only`). Work code can clone/push GitHub and install packages; it cannot touch the personal stack even if compromised. |
| Personal skills | No skills-sync init container: private personal skills (`.dotfiles`) are authenticated by the personal read token, which this pod does not have — and personal skills stay out of work sessions by design. |
| Factory tooling | No Executor MCP registration: the work runner cannot request factory runs on the personal cluster. |
| Backups | Work PVCs (`data-work-t3code-0`, `t3state-work-t3code-0`) are deliberately **not** in `deploy/backup/base` — work code and credentials never land in the personal restic/B2 bucket. Trade-off: a lost node means re-pairing the browser session and re-logging the CLIs; repos just re-clone. |
| Exposure | Only the Tailscale operator proxy and the Homepage siteMonitor can reach it (`netpol.yaml`). URL: `https://work-t3code-0.<tailnet>.ts.net`. |

## One-time bootstrap

1. **Create the PAT** at https://github.com/settings/personal-access-tokens/new (an account with access to the work organization):
   - Repository access: **Only select repositories** → select the work repositories the runner may touch (start with one or two).
   - Permissions: Contents **Read and write**, Pull requests **Read and write**
   - Never "All repositories"; never a personal repo. This scoping is the whole isolation contract — widening it is a reviewed PR to `docs/secrets-inventory.md` first.
2. **Store it in 1Password**: vault `homelab`, item `work-github-writer`, with TWO fields:
   - `token` — the raw PAT (no trailing newline)
   - `repos` — the repo URLs to clone, one per line, matching the PAT's Repository access list (e.g. `https://github.com/<org>/<repo>.git`)
3. **Bootstrap the ESO store** (once per cluster; the idempotent script takes the token from env/stdin/hidden prompt and never logs it):

   ```sh
   ./scripts/create-onepassword-service-account.sh work
   ```

4. **Apply everything**:

   ```sh
   KUBECONFIG=~/kubeconfig-homelab
   kubectl apply -k deploy/namespaces
   kubectl apply -k deploy/policies/base
   kubectl apply -k deploy/github-tokens/base   # work SecretStore + ExternalSecret
   kubectl apply -k deploy/work-t3code/base
   kubectl apply -k deploy/auto-deploy          # watchlist entry + work RBAC
   kubectl apply -k deploy/homepage/base        # dashboard entry
   kubectl apply -k deploy/tailscale            # work-t3code-serve-fixer (HTTPS proxy)
   ```

5. **Verify**:

   ```sh
   kubectl get secretstore -n work              # onepassword Ready
   kubectl get externalsecret -n work           # work-github-token SecretSynced
   kubectl -n work rollout status statefulset work-t3code
   kubectl get svc work-t3code-0 -n work \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'  # tailnet URL
   # The mounted token must NOT see personal repos (expect 404/NotFound):
   kubectl -n work exec work-t3code-0 -- \
     gh api repos/gwkline/homelab --jq .name 2>&1 | head -1
   # And the scoped clone worked: the workspace lists the work repos from
   # the 1Password `repos` field after first boot.
   kubectl -n work exec work-t3code-0 -- ls /data/repos
   ```

6. **Pair from the tailnet URL** (same flow as the personal t3code).

## Adding a repo / widening scope

Everything lives in the 1Password item `work-github-writer`: widen the PAT's _Repository access_ in GitHub (regenerate the PAT if needed), update the `token` field, and add the URL to the `repos` field. No git change. The ExternalSecret re-syncs within ~1h (or immediately after `kubectl -n work annotate externalsecret work-github-token \ force-sync=$(date +%s) --overwrite`), and the workspace updates on the next pod restart (`kubectl -n work rollout restart statefulset work-t3code`).

## Image updates

The t3code image floats its coding CLIs on npm dist-tags (`t3@nightly`, codex/claude-code `@latest`) — no CLI versions are recorded in this repo. Every image build resolves current versions (a CACHEBUST build-arg defeats the layer cache), CI rebuilds weekly on Monday 06:00 ET, and the `repin-t3code-image` job opens an automerging PR that pins the freshly published digest into both t3code StatefulSets; the auto-deploy watcher applies it (watchlist entry `statefulset,work-t3code,work,deploy/work-t3code/base/statefulset.yaml`). Manifests stay digest-pinned (issue #35) — the float lives in the build, not in what runs. Note: the repin PR is opened with the workflow's GITHUB_TOKEN, which does not trigger CI, so it needs an admin merge (weekly, Monday mornings) until a PAT-driven variant lands.

## Token rotation

Update the `token` field in 1Password (item `work-github-writer`). ESO converges ≤1h 6m; the file mount updates in place, but the running pod holds the old value in its exported `GH_TOKEN` — restart the StatefulSet after rotating.

## Claude Code auth (headless)

Claude's interactive paste-prompt does not consume non-TTY stdin, so the in-pod browser login flow cannot complete inside the pod. The work runner uses the supported headless path instead:

1. On a machine where you're logged into Claude: `claude setup-token` (prints a long-lived `claude_oauth_…` token)
2. Store it in 1Password: vault `homelab`, item `work-claude-oauth`, field `token` (no trailing newline)
3. The ExternalSecret (`base/claude-oauth.yaml`) syncs it into `work`; the StatefulSet injects it as `CLAUDE_CODE_OAUTH_TOKEN`. Claude reads that env var fresh in every session.

Rotate by minting a new token, updating the item, and `kubectl -n work rollout restart statefulset work-t3code` (env vars never update in a running pod).

## Depot builds (optional)

Work CI builds images with `depot bake`; the depot CLI ships in the image so runner agents can reproduce/inspect builds. It stays inert without `DEPOT_TOKEN`: store a Depot org token in 1Password (vault `homelab`, item `work-depot-token`, field `token`) and it syncs via `base/depot-token.yaml` — the env lands on the next rollout restart. Absent item = ExternalSecret `Ready=False` + runner unaffected.

## Codex auth

`codex login` (default browser OAuth) works headless via a callback tunnel: start `codex login` in the pod (it listens on localhost:1455), then `kubectl -n work port-forward work-t3code-0 1455:1455` from the operator machine and open the printed URL in a browser — the localhost redirect lands in the pod and the login completes itself. Tokens persist via the entrypoint's agent-state sync (`~/.codex/auth.json` → PVC).

Account caveat (2026-10-04): a workspace-managed ChatGPT account gets its token grant rejected at the token endpoint ("token_exchange_failed", org policy) even though the browser flow itself works — sign in with a personal ChatGPT account, or have the org enable device-code / unmanaged-client grants. `codex login --device-auth` remains the no-tunnel alternative once the org allows it; an API key (`printenv OPENAI_API_KEY | codex login --with-api-key`) needs no browser and no org policy, but bills at API rates instead of the plan.
