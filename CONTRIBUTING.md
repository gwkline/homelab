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
- Never commit tokens or kubeconfigs. Long-lived secrets are synced from 1Password by External Secrets (`deploy/github-tokens/base/`); the only manually created secret is the 1Password service-account token, applied at bootstrap via env/stdin without logging it.
- New workload checklist: namespace entry (+ PSA label choice), default-deny NetworkPolicy, `github-token` ExternalSecret coverage in that namespace (`deploy/github-tokens/base/`), manifests under `deploy/`, README "What runs here" entry.

## Adding a workload

Copy the closest existing pattern: StatefulSet + PVC + tailscale Service for long-running apps (`deploy/t3code/base/`), CronJob for batch work (`deploy/loop-agent/base/`). Keep privilege grants inside `sandbox`.
