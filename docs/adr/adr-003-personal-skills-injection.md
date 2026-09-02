# ADR-003: Personal-skills repository and injection contract

**Status:** Accepted (2026-09-02) **Deciders:** Gavin Kline, ox-alpha **Implements:** #69 · **Depends:** #68 (P-Stack final installation shape — precedence in D9 is designed so P-Stack slots in without rework)

## Context

Agents run under seven different harnesses on this cluster — T3 Code, Hermes, Cursor, Claude Code, Codex, OpenCode, and the factory workers (which ship the same CLIs as T3 Code). Personal skills (communication preferences, house conventions, private project context) are re-taught to each harness by hand today, drift between them, and cannot live in this public homelab repo because they carry personal context.

Prior art: `deploy/hermes/base/skills-sync.yaml` already clones one private repo (`gwkline/.dotfiles`) into `$HERMES_HOME/skills` with a manifest-allowlist + secret-scan gate, a pinned `ref`, and a degrade-never-fail `status.json` contract. Issue #69 generalizes that pattern to every harness. The operator has not yet decided whether to create the private skills repo now (human gate) — the design, contract scripts, and a local fixture below proceed independently.

Constraints:

- Private skills are personal context; this homelab repo is public.
- The same skill must reach every harness without per-harness re-authoring.
- A skill is trusted input: unreviewed fetched content must not be able to steer agents into running arbitrary code.
- Every run must be reproducible: same pin → same installed bytes.

## Decisions

### D1. Repository and visibility

One new **private** repository, default name `gwkline/.agent-skills` (the operator may pick any name — human gate in #69). The local fixture `examples/personal-skills-fixture/` in this repo is the seed: copying it into a fresh repo creates the skills repo. Public, reusable skills (useful beyond this operator) may also be authored in the canonical format and PR'd into this repo or upstream; private personal context lives only in the private repo. Nothing in this repo's deploy manifests points at the private repo until the operator creates it.

### D2. Canonical format — one manifest, no generated model

A skills repo contains `skills.yaml` at its root and one directory per skill:

```
skills.yaml                      # registry: trust + review state (below)
skills/<name>/SKILL.md           # YAML frontmatter: name, description; body = the skill
skills/<name>/<reviewed files>   # optional, must be listed under files:
```

`skills.yaml`:

```yaml
skills:
  - name: tailnet-etiquette
    description: Naming and phrasing etiquette for tailnet services
    allow: true # human review gate; false = not reviewed yet
    files: [] # non-markdown files a human has reviewed, e.g. [lookup.sh]
```

`SKILL.md` with `name`/`description` frontmatter is the emerging cross-harness agent-skill convention — Claude Code and OpenCode read it natively, so no per-harness generation step is needed; the remaining harnesses get thin copy/render adapters (D3).

### D3. Harness adapters

`scripts/install-personal-skills.sh` resolves a pinned skills source, applies the gates (D8), and installs each allowlisted skill into the configured adapters. Target directories are overridable via `SKILLS_DIR_<ADAPTER>`.

| Adapter | Target | Notes |
| --- | --- | --- |
| `claude` | `$HOME/.claude/skills/<name>/` | native Claude Code personal skills |
| `opencode` | `$HOME/.config/opencode/skill/<name>/` | native opencode skills |
| `hermes` | `$HERMES_HOME/skills/<name>/` | hermes reads skill dirs from its PVC |
| `cursor` | `$HOME/.cursor/rules/agent-skills-<name>.mdc` | rendered rule (`alwaysApply`), file owned by the installer |
| `codex` | `$HOME/.codex/AGENTS.md` | marker-guarded additive block (`<!-- agent-skills:<name>:begin/end -->`) |

T3 Code and factory workers ship the claude/codex/opencode CLIs (see `apps/t3code/Dockerfile`, `apps/factory/worker/Dockerfile`), so they consume the same adapters with the pod's `HOME` — no separate adapter.

### D4. Version pinning and update flow

Every consumer pins `SKILLS_REF` to an **immutable tag or full commit SHA**; floating refs (`main`) are rejected by the installer unless explicitly overridden with `SKILLS_ALLOW_FLOATING_REF=1`. Each run resolves and records the exact commit in per-target receipts and `status.json`, so any install is reproducible and auditable.

Update flow (deliberate, never automatic): author a skill → PR in the skills repo (review, D8) → merge → bump `SKILLS_REF` in the consumer's ConfigMap/env → next boot installs that commit. Rollback = repoint the pin. Skills are trusted input, so they update on a human bump, never by auto-tracking a branch.

### D5. Authentication — read-only, from runtime secrets

The skills repo gets a dedicated fine-grained PAT with **Contents: read on the skills repo only**, delivered as a runtime secret (mount of secret `github-token` or a dedicated `skills-token` at `/secrets/token`). The installer reads the token file and clones through a generated `GIT_ASKPASS` helper (same pattern as `apps/shared/workspace-lib.sh`): the token never appears in clone URLs, argv, env, or `.git/config`. No write token is ever used for skills.

### D6. Skill content hygiene

Skill content contains **no secret values and no machine-specific credentials** — no tokens, no real tailnet hostnames, no host paths, no per-machine config. Two enforcement layers: the installer secret-scans every skill before install (same pattern set as `scripts/verify.sh`) and refuses failing skills; authors write skills assuming they will be public ("assume public" rule). `SKILL.md` should teach _where credentials come from_ (e.g. "the token is already in your environment"), never their values.

### D7. Idempotency — never overwrite user state

- Each adapter writes only into targets the installer owns: a per-skill directory or an installer-named file. Ownership is recorded in receipts (`${SKILLS_STATE_DIR}/receipts/<adapter>/<skill>` = ref, resolved commit, content checksum, time).
- A target that exists **without** our receipt is user state: skipped with a loud warning, never overwritten.
- A receipted target is refreshed only when the pin's commit or the skill content changed; re-running with an unchanged pin is a no-op. Deleting a skill from the allowlist simply stops installing it — user directories are never pruned.
- Shared files (codex `AGENTS.md`) are modified only by additive, marker-guarded blocks, refreshed in place — never rewritten wholesale (same idiom as the SOUL.md injection in `apps/hermes/run-hermes.sh`).

### D8. Allowlist and trust gates (default-deny, three gates)

1. **Manifest review gate** — a skill installs only if `allow: true` in `skills.yaml`. Flipping that flag is the human review act and happens via PR in the skills repo. New skills are deny-by-default.
2. **Consumer allowlist** — `SKILLS_ALLOWLIST` (space-separated names) per workload (ConfigMap/env). A skill must be reviewed _and_ explicitly allowlisted for that consumer; nothing installs otherwise.
3. **File review gate** — any file in a skill directory that is not `SKILL.md` and not listed under `files:` marks the whole skill unreviewed; the installer refuses it. Fetched code therefore never ships or executes without a listed human review.

Skills are injected as instructions (markdown); the installer executes nothing from the skills repo at install time.

### D9. Precedence between skill layers (coordinates with #68)

| Precedence | Layer | Source | Rationale |
| --- | --- | --- | --- |
| 1 (highest) | project-local | the repo being worked in (its `AGENTS.md`, `.claude/`, `.opencode/`) | most specific; repo owner controls it |
| 2 | personal | private skills repo (this ADR) | personal defaults across all projects |
| 3 | P-Stack | product/stack-installed skills (#68, shape pending) | generic base layer, lower specificity |
| 4 (lowest) | generated | factory/agent-authored at runtime | ephemeral, least trusted; always written to a `generated/` namespace and never persisted over a higher layer |

Injection never overwrites a higher-precedence layer: adapters install personal skills into their own named targets (D7), so layering stays visible on disk, and same-named skills resolve by this order. #68 can define P-Stack's targets independently; only this table needs updating once its installation shape is final.

### D10. Failure contract and CI

Inside pods the installer degrades-never-fails (errors → `status.json` + loud warning, exit 0 — identical to `deploy/hermes/base/skills-sync.yaml` and `apps/hermes/check-skills-sync.sh`); `SKILLS_STRICT=1` makes errors fatal for CI and local runs. `scripts/check-personal-skills.sh` runs in CI and validates the fixture end-to-end: manifest consistency, secret scan, and the sample skill installing into three adapters in a throwaway sandbox.

Example consumer wiring (once the operator creates the repo — human gate), e.g. in a t3code/hermes StatefulSet or a factory RunProfile `envAllowlist`:

```yaml
env:
  - name: SKILLS_SOURCE
    value: https://github.com/gwkline/.agent-skills
  - name: SKILLS_REF # pin: tag or full SHA — never main
    value: "2026.09.0"
  - name: SKILLS_ALLOWLIST
    value: "tailnet-etiquette"
  - name: SKILLS_ADAPTERS # e.g. "claude codex" in t3code; "hermes" in hermes
    value: "claude hermes"
```

Hermes' existing `.dotfiles` skills sync keeps running unchanged; migrating it onto this contract (it already uses this adapter) is an operator follow-up after the human gate.

### D11. Public/private split and accidental-publication checks

- **Public repo (this one):** the canonical format definition, the contract scripts, and exactly one fixture — `examples/personal-skills-fixture/` — which contains only generic, harmless content. Personal skills are **never committed here**.
- **Private repo:** everything personal. Written under the assume-public rule (D6) so an accidental flip to public leaks nothing sensitive.
- Checks that keep the split honest, all enforced by CI:
  - `scripts/check-personal-skills.sh` — fixture must be fully registered in its manifest (no unlisted dirs can ride in), plus a secret-pattern scan over the fixture.
  - `scripts/verify.sh` secret-pattern scan over the working tree **and all reachable history** — a token committed by accident fails CI.
  - `scripts/verify.sh` no-hard-coded-tailnet-suffix check — machine-specific hostnames fail CI (covers `examples/` and `docs/`, including the fixture).

## Consequences

- One authoring format, seven harnesses: personal skills are written once as `SKILL.md` + manifest entry and reach every agent through `scripts/install-personal-skills.sh` with per-consumer pins and allowlists.
- The operator bootstrap (human gate, #69): create the private repo from the fixture, create the read-only PAT, then set `SKILLS_SOURCE`/`SKILLS_REF`/`SKILLS_ALLOWLIST` on the consumers (snippet in D10). Until then, no manifest in this repo references the private repo and nothing changes at runtime.
- Two extra small scripts and one CI step; the demo proves the acceptance criterion "one harmless sample skill loaded by at least two harnesses" (claude + hermes + codex sandboxes) on every CI run.
- Open follow-ups: P-Stack layer lands with #68 (D9 reserves its precedence slot); hermes migration off `.dotfiles`-only skills is deferred to the operator; the Cursor adapter renders rules, so Cursor-native skill support (if upstreamed) only changes its default target dir.
