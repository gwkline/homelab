# GitHub App for the software factory (#70)

**Status:** Accepted · **Implements:** #70 · **Relates to:** ADR-002 (`factory-v1-github-ledger.md`), 1Password contract #39, provider connection #41

Replaces long-lived writer PATs in the factory path with **short-lived GitHub App installation tokens** scoped to selected repositories and operations. Code in `apps/factory/github-app/` is built and tested with mock keys; going live requires the operator gate below.

## Human gate (operator)

The token service can only mint tokens once a GitHub App exists:

1. Create the App: <https://docs.github.com/en/apps/creating-github-apps> → **GitHub App** (not OAuth App). Homepage can be this repo; **deactivate webhooks** (no receiver exists, so no webhook secret is needed — if one is ever added, it lives only in 1Password).
2. Grant **only** the permissions listed below and set **Repository access → Only select repositories** to the factory allowlist (`gwkline/homelab`, `gwkline/launchpad`, `gwkline/plantry`, `gwkline/personal-site`, `gwkline/kline-services-bot`, `gwkline/discord-bot`, `gwkline/pr-czar` — never "All repositories").
3. Download the private key (`.pem`) once and put it straight into 1Password. **Never paste the private key (or webhook secret) into an issue, PR, chat, or any file in this repo.**
4. Install the App on the selected repositories and note the numeric **App ID** and **installation ID**.

## 1Password item contract (aligns with #39 / #41)

One dedicated item, name `factory-github-app`, fields:

| Field | Value | Notes |
| --- | --- | --- |
| `app-id` | numeric App ID | shown on the App settings page |
| `installation-id` | numeric installation ID | from the install URL `/installations/<id>` |
| `private-key` | full `.pem` contents | PKCS#1/PKCS#8 PEM; `\n` escapes accepted |
| `webhook-secret` | _(optional, empty today)_ | only when a webhook receiver is deployed |
| `client-id` | _(optional)_ | informational only |

Sourcing rules: operators reference the item (`op://…`) in local shells; nothing is committed. Values reach the cluster only via `scripts/create-github-app-secret.sh`, which creates Secret `github-app` (keys `app-id`, `installation-id`, `private-key`, optional `webhook-secret`) from env or prompts:

```sh
op read 'op://…/private-key' ...        # your shell, not a command line in git
GITHUB_APP_ID=… GITHUB_APP_INSTALLATION_ID=… GITHUB_APP_PRIVATE_KEY="$(…)" \
  scripts/create-github-app-secret.sh sandbox
```

## Permissions — documented and minimal

App-level permissions (what you request when creating the App):

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | mandatory, auto-selected; repo lookups (`default_branch`) |
| Issues | Read and write | read: collector lists issues (criteria floor: _Issues read_); write: label swaps + run-event comments — the ADR-002 ledger's state machine has no other storage, so this is the one unavoidable write |
| Contents | Read and write | clone, push factory branches, commit `.factory/report.md` |
| Pull requests | Read and write | draft PR create/update, dedupe lookups |
| Checks/Actions | **not granted** | nothing consumes check-run APIs via this App; revisit only when a concrete workflow needs them |
| Webhooks | deactivated | no receiver |

No Administration, no Secrets, no Org/Org-webhook permissions. Anything not in the table is a regression — refuse it.

### Per-consumer narrowing (where GitHub supports it)

Each mint request narrows to a subset of the installed permissions (`POST /app/installations/{id}/access_tokens` with `permissions`):

| Consumer | Requested permissions | Notes |
| --- | --- | --- |
| read-only collector | `metadata:read, issues:read, contents:read` | pure reads. Until the queued-label write moves to the write path, its mint adds `issues:write` (migration TODO below) |
| write-capable publisher | `contents:write, pull_requests:write, issues:write` | the only component that pushes branches / opens draft PRs; `issues:write` solely for run-event comments |
| smoke test | `contents:write, issues:read, metadata:read` | read issue + create/delete a test branch |

Workers never receive any token (ADR-001 D6): they clone via the runtime-built `CLONE_URL`, which carries a short-lived token only inside the pod env.

## Token service (`apps/factory/github-app/`)

Zero-dependency TypeScript:

- `token-service.ts` — `signAppJwt()` (RS256, 9-minute JWT within GitHub's 10-minute cap) and `createTokenService()` with **expiry-aware caching**: tokens (GitHub TTL 1 h) are cached in memory **per permission set** and refreshed 5 minutes before expiry; `clear()` drops the cache after a revocation.
- `mint.ts` — CLI. Reads `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` (or `GITHUB_APP_PRIVATE_KEY`), writes the token to `--out FILE` (mode 0600; prints only the expiry) or `--stdout` (explicit opt-in for piping). Defaults to refusing to print the token.

Non-persistence rules (enforced by review + tests):

- **Memory only** — the cache is a `Map` inside the service; nothing is written to disk except the `--out` hand-off file (0600, mktemp/`emptyDir` semantics, never a PVC).
- **Never in Job manifests** — no literal token in YAML; consumers read `GH_TOKEN_FILE` (publisher already supports it) or runtime env from a mint step.
- **Never in logs** — error messages are fixed strings + HTTP status only; tests assert the JWT, the minted token, and response bodies never appear.
- **Never in database rows** — the factory has no database (ADR-002).

Intended in-cluster wiring once the gate passes (example, not committed as a manifest — the publisher Job spec is generated by the orchestrator):

```yaml
initContainers:
  - name: mint-token
    image: ghcr.io/gwkline/homelab/factory/github-app-token:latest # to be built
    command: ["node", "--experimental-strip-types", "/app/mint.ts"]
    args:
      [
        "--permissions",
        "contents:write,pull_requests:write,issues:write",
        "--out",
        "/tokens/gh-token",
      ]
    env:
      - {
          name: GITHUB_APP_ID,
          valueFrom: { secretKeyRef: { name: github-app, key: app-id } },
        }
      - {
          name: GITHUB_APP_INSTALLATION_ID,
          valueFrom:
            { secretKeyRef: { name: github-app, key: installation-id } },
        }
      - {
          name: GITHUB_APP_PRIVATE_KEY_FILE,
          value: /secrets/github-app/private-key,
        }
    volumeMounts:
      - { name: tokens, mountPath: /tokens }
      - { name: github-app, mountPath: /secrets/github-app, readOnly: true }
# then: publisher container env GH_TOKEN_FILE=/tokens/gh-token,
# volumes: tokens = emptyDir (memory-backed pod lifetime), github-app = secret
```

Until that lands, the operator can mint locally with `npm run mint -- --out /tmp/gh-token …` and hand the file to a one-off publisher run. Retire the writer PAT only after `smoke-test.sh` passes against the real App.

## Tests

- **Integration (mocked JWT/token exchange, no network, throwaway RSA keys generated per run):**

  ```sh
  cd apps/factory/github-app && npm test
  ```

  Covers: JWT claim shape + RS256 signature verification (and tamper rejection), the exchange request shape, expiry-aware caching/refresh margin, per-permission-set cache keys, credential validation, CLI spec parsing, and the redaction guarantees.

- **Manual smoke (real GitHub, real App token):** reads an issue, creates and deletes a throwaway `factory/app-smoke-<ts>` branch:

  ```sh
  # token minted automatically from GITHUB_APP_* env, or reuse GH_TOKEN/GH_TOKEN_FILE
  REPO=gwkline/launchpad ISSUE=<n> sh apps/factory/github-app/smoke-test.sh
  ```

## Rotation, revocation, and clean recovery

- **Planned key rotation** (App settings → Private keys): _Generate a new private key_ → replace `private-key` in the 1Password item → re-run `scripts/create-github-app-secret.sh` → restart consumers (CronJobs mint lazily, so a restart is enough) → run `smoke-test.sh` → only then _Remove_ the old key. The old key keeps minting until removed, so never leave it in place after cutover.
- **Suspected key compromise:** remove the key in GitHub immediately (JWT minting dies at once; already-minted tokens live ≤1 h), then rotate as above. Installation tokens are 1-hour credentials — a leaked token expires on its own; if the blast radius matters, _Revoke_ the installation for a hard kill (all its tokens invalidate immediately).
- **Lost key:** generate a new private key on the same App and follow the rotation steps — nothing else changes.
- **Deleted App / wrong installation:** recreate the App, reinstall on the selected repos, update `app-id`/`installation-id` in 1Password and the `github-app` secret.
- **Clean recovery after any of the above:** re-apply `scripts/create-github-app-secret.sh`, restart the factory CronJobs, confirm `smoke-test.sh` passes, then unsuspend. The PAT fallback (`github-token` secret) stays available until the App path is verified end-to-end.

## Migration TODO (post-gate)

1. Add the `github-app` secret to `sandbox` (script above).
2. Point publisher/orchestrator mint steps at the App token (`GH_TOKEN_FILE`), keeping `issues:write` off the collector by moving the queued-label write to the write path.
3. Retire the writer PAT from `github-token`; keep a read-only PAT for non-factory consumers.
