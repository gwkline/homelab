# Rebuild Runbook — full teardown → clean bring-up

**Goal:** `kubectl delete` everything, re-apply from git, enter N secrets, and every workload comes back identical. No manual scripts, no out-of-band fixes.

**Status:** DRAFT — implements the decisions from the 2026-08-25 drift audit.

---

## What breaks today if we tear down (the gap list)

| # | Gap | Fix in this PR set |
| --- | --- | --- |
| 1 | Tailscale operator: helm release is `failed`; chart hardcodes `PROXY_TAGS=tag:k8s` and its own values key doesn't override it → duplicate env or wrong tag on reinstall | `deploy/tailscale/values.yaml` + install script; tags via svc annotations (already correct path) |
| 2 | `github-token` secret missing entirely (t3code/hermes mount it optional — silently no private repos) | documented one-liner + README |
| 3 | hermes gateway doesn't autostart after pod restart (nohup hack) | ConfigMap `command` key (designed hook) |
| 4 | t3code svc missing `tailscale.com/tags` annotation in git | added to service.yaml |
| 5 | nomodeset not in grub.cfg despite /etc/default/grub edit (update-grub ran at 13:43 but grep shows 0 — needs sudo to verify actual state) | runbook step with verification command |
| 6 | sidecar `.mjs` runtime copies hand-made in PVC | initContainer copies from image plugin dir at startup |

## Secrets needed after rebuild (complete list)

1. `github-token` — ns agents (+ sandbox when used). Via existing `scripts/create-github-secret.sh`. PAT scope: fine-grained, Contents:read.
2. Tailscale OAuth — via `helm upgrade --set oauth.clientId/Secret` (values from Mac Keychain `homelab-tailscale`).
3. That's it. CNPG/bootstrap secrets self-generate.

## Node prerequisites (agent-1)

1. `/etc/default/grub`: `GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nomodeset"`
2. **`sudo update-grub`** then verify: `sudo grep -c nomodeset /boot/grub/grub.cfg` → must be ≥1 (2026-08-25: cfg was regenerated 13:43 but contains 0 matches for nomodeset as user; root check pending sudo. If truly absent, suspect a `/etc/default/grub.d/` override or grub install issue — investigate before relying on headless reboots.)
3. k3s running (`systemctl status k3s`), tailscale up.

## Bring-up order

```sh
# 0. node ready per above

# 1. CRDs/operator for tailscale
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  -n tailscale --create-namespace \
  --set oauth.clientId="$TS_CLIENT_ID" \
  --set oauth.clientSecret="$TS_CLIENT_SECRET"
kubectl -n tailscale set env deploy/operator PROXY_TAGS=tag:k8s-operator  # chart bug workaround (documented)
kubectl rollout restart deploy/operator -n tailscale

# 2. secrets
GITHUB_PAT=... ./scripts/create-github-secret.sh agents sandbox

# 3. workloads
kubectl apply -f deploy/namespaces.yaml
kubectl apply -k deploy/policies/base
kubectl apply -k deploy/tailscale          # serve-fixer
kubectl apply -k deploy/t3code/base
kubectl apply -k deploy/hermes/base
kubectl apply -k deploy/loop-agent/base
kubectl apply -k deploy/panel/base         # admin portal (https://panel.$TAILNET_NAME)

# 3b. HTTPS for tailscale-proxied services (one-time tailnet approval already
# granted; re-run after operator reinstall or proxy pod replacement)
./scripts/serve-https.sh                   # t3code
# Automatic self-healing: the t3code serve-fixer (deploy/tailscale/) runs a
# loop in the tailscale namespace that re-points the serve entry at the app
# pod's current IP within ~30s of a pod replacement, logging one line per
# check; unreachable proxy pods fail loudly (container restarts, error in
# `kubectl logs -n tailscale deploy/t3code-serve-fixer`). panel — or any
# exposed app: serve-refresh.sh <app> <namespace>.
# Also the one-command fix whenever a replaced app pod leaves its serve
# entry pointing at a dead IP (502s): it re-points the entry at the current
# pod IP, idempotently, printing serve status before/after.
./scripts/serve-refresh.sh panel agents

# 4. wait & verify
kubectl get pods -A -w
# TAILNET_NAME is the one documented tailnet config value
# (deploy/tailscale/README.md); scripts/serve-https.sh auto-discovers it.
curl -s -o /dev/null -w "%{http_code}\n" "http://t3code-0.${TAILNET_NAME:-<tailnet>}/"
```

## PR checklist (this branch)

- [ ] t3code svc: add `tailscale.com/tags: tag:k8s-operator` annotation
- [ ] hermes-workspaces CM: add `command: hermes gateway run`
- [ ] deploy/tailscale/README.md: document chart PROXY_TAGS bug + workaround, secret locations, rebuild order (absorb this file's content)
- [ ] apps/hermes Dockerfile or entrypoint: ensure photon sidecar dir fully populated at start (copy from plugin dir if incomplete)
- [ ] scripts/rebuild-check.sh: post-bring-up conformance sweep (kubectl diff all manifests = empty; pods Running; URL 200)
