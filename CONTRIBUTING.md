# Contributing

Small repo, few rules.

## Before opening a PR

```sh
./scripts/verify.sh
```

It must pass. It runs the same checks CI runs: shell lint, manifest builds, secret-pattern scan, image-reference consistency.

## Conventions

- Manifests live under `deploy/<workload>/base/` as kustomize bases. No overlays exist yet; edit `base/` until someone needs an overlay.
- Shell scripts are POSIX sh (or bash where `read -s` is needed) and must stay shellcheck-clean.
- Never commit tokens or kubeconfigs. Secrets enter the cluster only via `scripts/create-github-secret.sh`.
- New workload checklist: namespace entry (+ PSA label choice), default-deny NetworkPolicy, `github-token` secret in that namespace, manifests under `deploy/`, README "What runs here" entry.

## Adding a workload

Copy the closest existing pattern: StatefulSet + PVC + tailscale Service for long-running apps (`deploy/t3code/base/`), CronJob for batch work (`deploy/loop-agent/base/`). Keep privilege grants inside `sandbox`.
