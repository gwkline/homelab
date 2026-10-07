# ADR-007: Personal-skills repository and injection contract

**Status:** Accepted — the private skills repo is `gwkline/.dotfiles`, consumed by hermes, t3code, and factory workers via `apps/shared/skills-lib.sh` (pinned ref + path allowlist + secret scan, deployed and verified in production). The generic multi-harness installer below remains implemented and fixture-tested for harnesses that need adapter formats (cursor, codex), but is not yet wired to a live consumer. **Deciders:** Gavin Kline

## Context

Agents run under several harnesses here — T3 Code, Hermes, Cursor, Claude Code, Codex, OpenCode, and the factory workers (which ship the T3 Code CLIs). Personal skills (communication preferences, house conventions, private project context) are re-taught to each by hand, drift, and cannot live in this public repo.

Prior art: `deploy/hermes/base/skills-sync.yaml` already clones a private repo into `$HERMES_HOME/skills` with an allowlist, secret scan, pinned ref, and a degrade-never-fail `status.json`. This ADR generalizes that to every harness.

Constraints: personal content stays private; one skill reaches every harness without re-authoring; fetched content cannot steer agents into running unreviewed code; the same pin always installs the same bytes.

## Decisions

### D1. Repository

One private repository: `https://github.com/gwkline/.dotfiles` (the personal-skills repo this ADR originally sketched as `.agent-skills` was never created; `.dotfiles` is the source of truth). Its layout is `skills/<category>/<skill>/SKILL.md` with no `skills.yaml` registry — the deployed consumers (`apps/shared/skills-lib.sh`, wired in `deploy/hermes/base/skills-sync.yaml` and `deploy/t3code/base/skills-sync.yaml`) pin a ref and gate by `SKILLS_ALLOWLIST` path list. `examples/personal-skills-fixture/` in this repo is the seed and the CI fixture for the generic installer path.

### D2. Format

```
skills.yaml                      # registry: review state per skill
skills/<name>/SKILL.md           # frontmatter name + description; body = the skill
skills/<name>/<reviewed files>   # optional; must be listed under files:
```

```yaml
skills:
  - name: tailnet-etiquette
    description: Naming and phrasing etiquette for tailnet services
    allow: true # human review gate
    files: [] # reviewed non-markdown files
```

`SKILL.md` with frontmatter is read natively by Claude Code and OpenCode; other harnesses get thin adapters.

### D3. Adapters (`scripts/install-personal-skills.sh`)

| Adapter | Target (override: `SKILLS_DIR_<ADAPTER>`) | Notes |
| --- | --- | --- |
| `claude` | `$HOME/.claude/skills/<name>/` | native |
| `opencode` | `$HOME/.config/opencode/skill/<name>/` | native |
| `hermes` | `$HERMES_HOME/skills/<name>/` | PVC skill dirs |
| `cursor` | `$HOME/.cursor/rules/agent-skills-<name>.mdc` | rendered rule, installer-owned |
| `codex` | `$HOME/.codex/AGENTS.md` | marker-guarded block `<!-- agent-skills:<name>:begin/end -->` |

T3 Code and factory workers use the claude/codex/opencode adapters with the pod's `HOME`.

### D4. Pinning

`SKILLS_REF` must be an immutable tag or full SHA; floating refs are rejected unless `SKILLS_ALLOW_FLOATING_REF=1`. Updates are a PR in the skills repo followed by a pin bump in the consumer; rollback is repointing the pin.

### D5. Authentication

A dedicated fine-grained PAT with Contents: read on the skills repo only, mounted at `/secrets/token` (`GITHUB_TOKEN_FILE`). The installer clones through a generated `GIT_ASKPASS` helper, so the token never appears in URLs, argv, env, or `.git/config`.

### D6. Content hygiene

Skills carry no secret values, real tailnet hostnames, host paths, or machine config — write them as if public. The installer secret-scans each skill and refuses failures.

### D7. Idempotency

- Adapters write only installer-owned targets, recorded in receipts (`$SKILLS_STATE_DIR/receipts/<adapter>/<skill>`: ref, commit, checksum, time).
- An existing target without a receipt is user state: skipped with a warning, never overwritten.
- Unchanged pin and content = no-op. Removing a skill from the allowlist stops installing it; nothing is pruned.
- Shared files (codex `AGENTS.md`) change only inside marker-guarded blocks.

### D8. Trust gates (default-deny)

1. `allow: true` in `skills.yaml` (the human review act, via PR in the skills repo).
2. The consumer's `SKILLS_ALLOWLIST` names the skill.
3. Any file other than `SKILL.md` not listed under `files:` blocks the whole skill.

The installer executes nothing from the skills repo.

### D9. Precedence

| Rank | Layer | Source |
| --- | --- | --- |
| 1 | project-local | the repo being worked in (`AGENTS.md`, `.claude/`, `.opencode/`) |
| 2 | personal | the private skills repo |
| 3 | P-Stack | stack-installed skills (`apps/factory/worker/skills/p-stack`) |
| 4 | generated | agent-authored at runtime, under a `generated/` namespace, never persisted over a higher layer |

### D10. Failure contract, CI, and wiring

In pods the installer degrades but never fails (errors → `status.json`, exit 0); `SKILLS_STRICT=1` makes errors fatal. `scripts/check-personal-skills.sh` (run by `scripts/verify.sh`, so in CI) validates the fixture: manifest consistency, secret scan, install into claude/hermes/codex sandboxes, idempotent re-run, default-deny, no overwrite of user content, unreviewed-file rejection.

Remaining work to make this functional — wire a consumer (e.g. t3code or hermes) with:

```yaml
env:
  - name: SKILLS_SOURCE
    value: https://github.com/gwkline/.agent-skills
  - name: SKILLS_REF # tag or full SHA, never main
    value: "<tag>"
  - name: SKILLS_ALLOWLIST
    value: "tailnet-etiquette"
  - name: SKILLS_ADAPTERS
    value: "claude codex"
```

plus the read-only PAT Secret, and migrate the hermes `.dotfiles` sync onto this contract.

## Consequences

- One authoring format for every harness; per-consumer pins and allowlists.
- Personal skills never land in this repo; `scripts/verify.sh` secret and tailnet-suffix scans cover the fixture and docs.
