# Tracker governance

How the GitHub issue tracker for gwkline/homelab is run. The tracker is the planning backbone for the cluster and its software factory: roadmap, bugs, audit findings, and chores all live here, and an agent PM (Hermes) grooms it so every issue is small, labeled, and carries acceptance criteria.

## Labels

Every issue carries a kind and a priority. Add the area label that names the surface the work touches; a cross-cutting issue may carry no area.

| Axis | Labels | Meaning |
| --- | --- | --- |
| Kind | `kind:product` `kind:bug` `kind:chore` `kind:infra` `kind:security` `kind:docs` `kind:audit` | What the issue is. New services and capabilities are `kind:product`; breakage is `kind:bug`; invisible maintenance is `kind:chore`; platform plumbing is `kind:infra`; reviews that produce tracked findings are `kind:audit`. |
| Priority | `priority:P0` … `priority:P3` | P0 must be fixed before relying on the system, P1 is the next major capability or reliability work, P2 is a valuable follow-up, P3 is later or optional. |
| Area | `area:k3s` `area:networking` `area:storage` `area:backup` `area:security` `area:apps` | Which surface the work touches. Legacy areas (`area:factory`, `area:agents`, `area:data`, `area:knowledge`, `area:devtools`, `area:observability`, `area:platform`, `area:recovery`, `area:media`) stay valid — the new six are the default for work that does not fit one. |

### Repo-specific labels

- `epic` — a tracker issue composed of independently deliverable work; the parts are filed as their own issues and linked back.
- `research` — a time-boxed investigation that ends in a recorded decision, not code.
- `tech-debt` — simplification and robustness work.
- `factory` / `factory/*` — the software factory's admission and lifecycle labels; `factory` is maintainer-only ([docs/github-app.md](docs/github-app.md)).

Priority belongs to the roadmap, not to whoever filed the issue — the PM loop sets it, and a comment from Gavin overrides it.

## Filing issues

- Use a template: **Feature request**, **Bug report**, or **Ops / chore**. Acceptance criteria are required. An issue without a definition of done is a discussion, not work; it gets closed as `not planned` with a note.
- Audit findings (security sweeps, version-drift reviews, hardening passes) are filed as individual issues labeled `kind:audit` plus the touched areas, under the umbrella epic for that sweep. No finding stays in a comment where nothing tracks it.
- One issue per deliverable. When a request spans several separately shippable pieces, the grooming loop splits it and links the parts.
- Agents file issues with `gh issue create` carrying the same fields — the templates describe the shape, not just the web form.

## The agent PM loop

Hermes grooms this tracker on a schedule:

1. **Triage.** New issues get kind, area, and priority within a day of filing. Duplicates are closed with a link to the original.
2. **Shape.** Anything without acceptance criteria gets a proposed checklist as a comment; the author or Gavin accepts or edits it. Oversized issues are split.
3. **Roadmap.** Proposed work lands as `kind:product` issues. Gavin signals what is real by promoting a priority (P0/P1) or by commenting — silence means P3.
4. **Deliver.** Changes reach the cluster only through git: PR → green `ci` → merge → deployer pass ([CONTRIBUTING.md](CONTRIBUTING.md)). An issue that needs a manual `kubectl apply` says which step. Factory PRs never touch `.github/` (ADR-001 D7), so tracker mechanics — labels, templates, this file — are maintainer work.
5. **Sweep.** Issues with no activity for six weeks get a nudge comment, then close as `not planned` unless someone claims them.
