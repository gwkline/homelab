# Agent guidance

For every agent working in this repo: factory workers, hermes, t3code sessions and laptop sessions. [CONTRIBUTING.md](CONTRIBUTING.md) has the conventions; this file adds what an agent needs on top of them.

## Before you open a PR

```sh
npm ci
npm run lint && npm run format:check && npm run typecheck && npm test
./scripts/verify.sh   # needs shellcheck, kubectl, jq, openssl and gitleaks
```

`ci` is the one required check. It also builds every image whose inputs the PR changes.

## How a change reaches the cluster

- Merging to `main` deploys. Within one deployer pass of `ci` going green, the deployer applies the kinds in its target list (`deploy/deployer/base/deploy.sh`) with the new images. Everything else, such as RBAC, Services and the deployer itself, waits for a human to apply it ([deploy/deployer/README.md](deploy/deployer/README.md)). Say in the PR which manual apply it needs.
- Change the cluster through git, not with `kubectl apply`, `edit` or `patch` on live objects: the next deployer pass or `kubectl apply -k clusters/home` overwrites them.

## Credentials

- Use the credentials your environment already has, and check them with `gh auth status`. Never write a token, or an `export` of one, into a command line, script, dotfile, commit, PR or log. Hermes' environment is described in [deploy/hermes/README.md](deploy/hermes/README.md).
- A factory worker's agent has no GitHub credential and no kubeconfig. Leave the change in the clone, committed or not; the orchestrator turns the diff into the PR ([ADR-001](docs/adr/adr-001-factory-run-contract.md) D5 and D6).
- Never print Secret data (`kubectl get secret -o yaml`, `base64 -d`). Credentials come from 1Password through External Secrets, and a new secret reference gets a row in [docs/secrets-inventory.md](docs/secrets-inventory.md) first.
- From a laptop, name the homelab kubeconfig on every command (`KUBECONFIG=~/kubeconfig-homelab kubectl ...`, [docs/runbook-server-cluster.md](docs/runbook-server-cluster.md) step 4) rather than trusting the current context.

## Factory PRs

A factory PR must not change what admits or merges it: `.github/`, `apps/factory/collector/`, `apps/factory/reviewer/`, `apps/factory/lib/` and `renovate.json`. The orchestrator refuses to publish such a patch ([ADR-001](docs/adr/adr-001-factory-run-contract.md) D7).

## Writing

Comments and docs say why the code is the way it is now; history belongs in git. A doc claim that a change makes false is part of that change. README's security model is checked against the live cluster: re-verify it and update its date when you touch it.
