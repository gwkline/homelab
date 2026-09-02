# Branch Protection & Supply-Chain Security (2026-08-28)

## gwkline/homelab (public, runs cluster infra)

### Branch protection (ruleset #21399627 + branch protection API, both active)

- 9 required CI checks (validate + all 8 build jobs), strict up-to-date
- Linear history, no force-push, no deletion (branch protection + ruleset)
- Ruleset `pull_request` rule: `require_extra_approval_for_unattributed_changes: true` — a PR from anyone OTHER than the repo author/collaborator needs explicit human approval before merge, even if CI is green. This is the public-repo poison-pill defense.
- Review requirement: 0 (factory identity == repo owner; GitHub blocks self-approval anyway, and CI is the real gate)
- Admin bypass: enabled (enforce_admins false) — deliberate operator escape hatch
- Required signatures: DISABLED — factory worker commits are unsigned API-token commits; requiring signatures broke every auto-merge (found 2026-08-28)

### Attack-surface audit (2026-08-28, all clean)

- Collaborators: gwkline only (admin)
- Deploy keys: 0
- Webhooks: 0
- Actions default workflow permissions: read-only; can_approve_pull_request_reviews: false

### Remaining accepted risks

- `pull_request_target`-style workflows: none present (CI uses `pull_request`)
- Fork PRs run CI with a read-only GITHUB_TOKEN — secrets are not exposed to forks
- Anyone can OPEN an issue; only `factory/queued` labeled issues trigger workers, and only the repo owner (factory PAT) can label — spam issues cost nothing

## gwkline/launchpad (private, free tier)

- Branch protection/rulesets unavailable on free private repos (403).
- Mitigation: repo is private; collaborators = gwkline only. GitHub Pro ($4/mo) unlocks identical protection if the repo ever becomes sensitive.

## Factory identity

- Read-only credential: 1Password item `homelab/github-readonly` (field `token`) → k8s Secret `github-token` (agents + sandbox ns) via ExternalSecrets. Scopes: Contents R + Metadata R on homelab + launchpad.
- Writer credential: separate 1Password item `homelab/github-writer` (field `token`) → k8s Secret `github-token-writer` (sandbox ns). Scopes: Contents RW + Pull requests RW on target repos only. Transitional: writer PATs should later become GitHub App installation tokens.
- Rotation: update the item's `token` field in 1Password; it syncs into the cluster within ~1h and env-var consumers pick it up on restart (procedure: deploy/github-tokens/base/README.md).
