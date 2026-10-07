# hermes

The hermes agent gateway: a single-replica StatefulSet in `agents`. `HOME=/data/home` lives on the PVC, so the Claude and Codex CLI logins survive rollouts. Hermes only reads from Kubernetes (`base/rbac.yaml`). It asks for factory work through the Executor MCP gateway (`deploy/executor`), and `base/cluster-guide.yaml` tells the agent how.

## Prerequisites

- `github-token` in `agents` (1Password `github-readonly`, via `deploy/github-tokens`). It reaches the pod as `GH_TOKEN`/`GITHUB_TOKEN` and `/secrets/token`. Never write a token export into commands or dotfiles: hermes' pre-exec scanner flags it and forces an approval on every session.
- Optional: Secret `executor-client` (key `token`), issued by Executor for client id `hermes`. Without it the gateway boots with no factory tools.

  ```sh
  kubectl -n agents create secret generic executor-client --from-file=token=/path/to/token
  kubectl -n agents rollout restart statefulset hermes
  ```

## Apply

Part of `clusters/home`; the deployer rolls new images. Standalone: `kubectl apply -k deploy/hermes/base`.

## Verify

- Boot logs show `[hermes] GitHub auth OK (<user>)`, or a WARNING naming the check that failed.
- `kubectl auth can-i create jobs.batch -n sandbox --as=system:serviceaccount:agents:hermes` returns `no`.

## Token rotation

Update the `token` field of `github-readonly` in 1Password. ESO syncs it within an hour. Env vars only change when the pod restarts, so run `kubectl -n agents rollout restart statefulset hermes`.
