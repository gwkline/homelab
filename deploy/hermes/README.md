# hermes

The hermes agent gateway: a single-replica StatefulSet in `agents` whose entrypoint is `apps/hermes/run-hermes.sh`. `HOME=/data/home` lives on the PVC, so the Claude and Codex CLI logins survive rollouts. Hermes only reads from Kubernetes (`base/rbac.yaml`). Its factory tools would come from the Executor MCP gateway, which is not deployed (`deploy/executor`), so it has none; `base/cluster-guide.yaml` describes them to the agent.

On a fresh PVC the pod idles until `hermes setup --portal` has run ([docs/rebuild-runbook.md](../../docs/rebuild-runbook.md) 3.10).

## Prerequisites

- `github-token` in `agents` (1Password `github-readonly`, via `deploy/github-tokens`).
- Optional: Secret `executor-client` (key `token`), issued by Executor for client id `hermes`. Without it the gateway boots with no factory tools.

  ```sh
  kubectl -n agents create secret generic executor-client --from-file=token=/path/to/token
  kubectl -n agents rollout restart statefulset hermes
  ```

## Environment contract

What the pod gives the agent. `run-hermes.sh` also writes these rules into `$HERMES_HOME/SOUL.md`, which hermes injects into every session.

- `GH_TOKEN` and `GITHUB_TOKEN` are set from Secret `github-token`, and `/secrets/token` is a read-only mount of the same token for code that needs a file. `gh` and `git` are installed, so `git push` and `gh api` work with no setup.
- Never write a token export into a command, a script's command line, `.bashrc` or `.profile`. Hermes' pre-exec scanner flags it and forces a human approval on every session, and the token is already in the environment.
- At every boot `run-hermes.sh` deletes each line of `$HOME/.bashrc` and `$HOME/.profile` that mentions `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `PASSWORD` or `SECRET`. Non-interactive shells don't read `.bashrc` anyway, so environment set there never reaches the agent's commands.
- If GitHub auth fails, check it with `gh api user -q .login` and report it. Rotating the token is an operator step (below).

## Apply

Part of `clusters/home`; the deployer rolls new images. Standalone: `kubectl apply -k deploy/hermes/base`.

## Verify

- Boot logs show `[hermes] GitHub auth OK (<user>)`, or a WARNING naming the check that failed.
- `kubectl auth can-i create jobs.batch -n sandbox --as=system:serviceaccount:agents:hermes` returns `no`.

## Token rotation

Update the `token` field of `github-readonly` in 1Password. ESO syncs it within an hour. Env vars only change when the pod restarts, so run `kubectl -n agents rollout restart statefulset hermes`.
