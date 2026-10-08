# Contributing

## Before opening a PR

```sh
npm ci                 # one install for every app (npm workspaces)
npm run lint && npm run format:check && npm run typecheck && npm test
./scripts/verify.sh    # shell/Dockerfile/workflow lint, manifest builds and references, gitleaks
```

CI runs the same checks, plus every `apps/**/tests/*.test.sh` and `deploy/*/tests/*.test.sh` fixture test and the panel e2e against a kind cluster.

## Conventions

- One kustomize base per component under `deploy/<component>/base/`; compose it into `clusters/home/base/kustomization.yaml`. Scripts, tests, helm values and the README sit beside `base/`.
- Every base includes the `deploy/components/labels` Component. A base that runs an application also labels itself `app.kubernetes.io/name: <component>`. Factory CronJobs take their shared policy from `deploy/components/factory-cronjob`.
- Images built here are referenced as `ghcr.io/gwkline/homelab/<app>:latest`; `deploy/deployer` rolls them out. Add new homelab workloads to the deployer's target list.
- Shell is POSIX `sh` unless it needs bash, and stays shellcheck-clean. TypeScript is ESM, run directly with `--experimental-strip-types` where no bundle is needed.
- Never commit secrets or kubeconfigs. Credentials come from 1Password through External Secrets.
- Comments explain why the code is the way it is now. History belongs in git, not in comments.
