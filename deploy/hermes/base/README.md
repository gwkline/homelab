# hermes deployment

StatefulSet running the homelabby agent gateway. One replica, PVC-backed `/data` (agent home + HERMES_HOME survive rollouts).

## GitHub auth chain (zero human intervention)

```
secret github-token (fine-grained PAT, agents ns)
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

```sh
kubectl -n agents delete secret github-token
# recreate with the new PAT (key: token), then:
kubectl -n agents rollout restart statefulset hermes
```

Rotated tokens must keep at least: Contents read/write on the repos the agent works in. Boot logs show `[hermes] GitHub auth OK (<user>)` when healthy, or a WARNING naming the failed check.
