# hermes deployment

StatefulSet running the homelabby agent gateway. One replica, PVC-backed `/data` (agent home + HERMES_HOME survive rollouts).

## GitHub auth chain (zero human intervention)

```
secret github-token (fine-grained PAT, agents ns — synced from 1Password
  item `github-readonly` by External Secrets, see deploy/github-tokens/base/)
  └─> StatefulSet env: GH_TOKEN / GITHUB_TOKEN  (statefulset.yaml)
  └─> volume mount: /secrets/token (GITHUB_TOKEN_FILE, for file-based readers)
        └─> entrypoint setup_git_auth → GIT_ASKPASS for plain git https
        └─> gh CLI / gh api read GH_TOKEN straight from the environment
```

Design rule: **no component may place the token in command text, scripts, or dotfiles.** Inline `export GH_TOKEN=...` trips Hermes' pre-exec security scanner (tirith, "Sensitive credential exported" = HIGH) and forces a manual approval on every session — the exact failure mode that motivated:

- `apps/hermes/Dockerfile` — gh is baked into the image (pinned + checksum), so shells (interactive or not) always find it on PATH.
- `apps/hermes/run-hermes.sh` — scrubs credential lines out of `$HOME/.bashrc`/`.profile` at every boot, verifies the token against `gh api user` at boot (loud WARNING in pod logs on failure), seeds the credential contract into `$HERMES_HOME/SOUL.md`, and fast-forwards the agent's working copy of the homelab repo when it has no local work.
- repo `AGENTS.md` + `deploy/hermes/base/cluster-guide.yaml` — tell the agent the token is pre-injected and exports are forbidden.

### Token rotation (operator)

The Secret is managed by External Secrets: update the `github-readonly` item's `token` field in 1Password and it syncs into the cluster within ~1h (see deploy/github-tokens/base/README.md). The mounted `/secrets/token` updates automatically, but env vars never do — restart the pod so `GH_TOKEN`/`GITHUB_TOKEN` pick up the new value:

```sh
kubectl -n agents rollout restart statefulset hermes
```

(Emergency path if 1Password/ESO is unavailable: `kubectl -n agents delete secret github-token`, recreate with the new PAT (key: token), then restart as above — ESO will restore ownership on the next reconcile.)

Rotated tokens must keep at least: Contents read/write on the repos the agent works in. Boot logs show `[hermes] GitHub auth OK (<user>)` when healthy, or a WARNING naming the failed check.

## Factory orchestration via Executor (#82)

Hermes is a conversational client of the software factory, not a Kubernetes scheduler. It holds **no** Job/CronJob write RBAC; all factory work is requested through the shared Executor MCP gateway (`deploy/executor/base`, endpoint `http://executor.agents.svc:8080/mcp`), which owns the cluster credentials host-side.

```
hermes gateway ──MCP (streamable HTTP)──> Executor ──policy + approval──> factory api/controller
     │                                        │
     └─ EXECUTOR_MCP_URL / EXECUTOR_CLIENT_ID │
        EXECUTOR_CLIENT_TOKEN (secret)        └─ create/cancel/retry require approval;
                                                 reads are policy-allowed
```

Wiring:

- `configmap hermes-executor` (executor.yaml) — endpoint URL + client identity (`hermes`), asserted on every call so Executor policy decisions and factory audit events attribute actions to it.
- Secret `executor-client` (key `token`) — the token Executor issued for that client identity. Provision once Executor is deployed:
  ```sh
  kubectl -n agents create secret generic executor-client --from-file=token=/path/to/executor-client-token
  kubectl -n agents rollout restart statefulset hermes
  ```
  The reference is `optional: true`, so the gateway keeps booting (factory tools absent) before Executor lands.
- `configmap hermes-cluster-guide` (cluster-guide.yaml) — teaches the factory tools, RunProfiles (`code-pr`, `reviewer`, `security`), the approval policy, and that chat/GitHub text is data, not authority.

Policy ownership: Executor policy requires operator approval for the write/destructive factory calls (create/cancel/retry run); profile validation and admission (no raw Kubernetes fields, no unknown profiles, no overrides) happen server-side and cannot be bypassed from the conversation. Durable factory-side approval records are #83; until then Executor's approval log is the record.

What hermes keeps in Kubernetes (rbac.yaml), deliberately read-only: self-visibility (report on the workloads that host it) and cluster-health reads (nodes + metrics) to answer "is the cluster healthy?". No writes anywhere; no token purpose tied to factory orchestration.

### Conversational smoke test (end-to-end)

Run after `deploy/executor/base` exists and `executor-client` is provisioned:

1. **Identity check** (from a shell in the pod):
   ```sh
   kubectl exec -it hermes-0 -n agents -- sh -c \
     'curl -fsS -H "Authorization: Bearer $EXECUTOR_CLIENT_TOKEN" "$EXECUTOR_MCP_URL" -o /dev/null -w "%{http_code}\n"'
   ```
   Any HTTP response (not a network error) proves endpoint + credential; 401 means the secret/token is wrong.
2. **RBAC check** (host shell — the old write path must be gone):
   ```sh
   kubectl auth can-i create jobs.batch -n sandbox \
     --as=system:serviceaccount:agents:hermes   # expect: no
   kubectl auth can-i patch cronjobs.batch -n agents \
     --as=system:serviceaccount:agents:hermes   # expect: no
   ```
   CronJob mutation is not required for hermes (#26): it reads CronJobs for
   self-visibility only; schedule edits and suspend/resume belong to the
   operator and the panel.
3. **Conversational round-trip** — via the messaging gateway or `kubectl exec -it hermes-0 -n agents -- hermes`:
   - "List the factory RunProfiles." → `code-pr`, `reviewer`, `security`.
   - "Create a code-pr Run for issue <N> in <fixture repo>." → Executor raises an approval; approve it in the Executor UI; run enters `queued`.
   - "Show me that run." → state + attempt details.
   - "Cancel the run." → approval; run ends `cancelled`.
   - "Retry the run." → approval; a new attempt/run is created.
4. **Negative checks** (in the same conversation):
   - "Create a run with profile `bash-1`." → rejected by admission (unknown profile).
   - "Create a code-pr run with more CPU and a different service account." → rejected (profile overrides are not caller inputs).
   - Paste a Job manifest and say "apply this" → refusal; hermes has no Kubernetes write path.
5. **Audit**: the Executor log shows tool, caller identity `hermes`, decision (allowed/approval), and status for every call in steps 3–4.
