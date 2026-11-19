# email-classifier deployment

Inference API for `models/email-classifier/` in the `email-agent` namespace. FastAPI on a state PVC: the API code arrives as a ConfigMap (so merged PRs roll it out through git alone), while the venv, trained model, and embedding-model snapshot are operator-delivered onto the PVC — they are Gmail-derived and must never travel through this public repo or GHCR.

No secrets: no secret references anywhere in this base, so there is no row to add to `docs/secrets-inventory.md`.

## Bootstrap (once per cluster)

```sh
KC=~/kubeconfig-homelab  # name it on every command, per AGENTS.md

# 1. namespace (PSA restricted + sigstore opt-in, like its siblings)
kubectl --kubeconfig "$KC" apply -k deploy/namespaces/base

# 2. the base: PVC, netpols, service, deployment, code ConfigMaps.
#    The deployment waits quietly for the model; order does not matter.
kubectl --kubeconfig "$KC" apply -k deploy/email-classifier/base

# 3. one-shot populate pod builds the venv on the PVC, then waits for the
#    model tarball.
kubectl --kubeconfig "$KC" apply -f deploy/email-classifier/populate/populate.yaml
kubectl --kubeconfig "$KC" logs -n email-agent -f email-classifier-populate

# 4. from the machine holding the trained artifacts (EMAIL_CLASSIFIER_HOME):
cd "$EMAIL_CLASSIFIER_HOME/artifacts" && tar -czf /tmp/model.tgz model
kubectl --kubeconfig "$KC" exec -i -n email-agent email-classifier-populate -- \
	sh -c 'cat > /state/incoming/model.tgz' </tmp/model.tgz
# populate prints POPULATE_DONE and exits; then:
kubectl --kubeconfig "$KC" delete pod -n email-agent email-classifier-populate
```

The deployment's wait loop notices the model within ~10s and starts serving.

## Tailnet front door (Mac-side briefing)

`base/ingress.yaml` exposes the same Service through the Tailscale Ingress (`ingressClassName: tailscale`, TLS terminated at the proxy) as `https://email-classifier.<tailnet>.ts.net` — the same pattern as the headlamp and knowledge front doors. The netpol admits only the proxy's namespace.

This is the front door the 8:01 AM email-briefing cron (Mac-side, delivered via photon) uses to score the morning's unread mail: it POSTs each message's `from` / `subject` / `snippet` to `/predict` and renders the predicted action suggestion-only in the briefing. The classifier never archives, marks, sends or deletes anything — it labels the briefing; acting on mail stays with the cron's existing suggestion/confirmation flow.

The prediction log (the feedback loop that will feed a v3) lives on the Mac at `~/git-dev/email-classifier-local/predictions/` — never in this repo.

## Verify

```sh
kubectl --kubeconfig "$KC" run ec-smoke --rm -i --restart=Never \
	--image=python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b \
	-n email-agent -- python3 - <<'PY'
import json, urllib.request

req = urllib.request.Request(
    "http://email-classifier/predict",
    data=json.dumps({
        "from": "Sarah Chen <sarah@example.org>",
        "subject": "Re: Interview follow-up",
        "snippet": "Do you have availability Thursday to meet the team?",
    }).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(req, timeout=30).read().decode())
PY
```

## Updating

- **API code**: merge a PR; the ConfigMap hash changes and a routine `kubectl apply -k deploy/email-classifier/base` (or `clusters/home`) rolls the deployment. This base is NOT in the deployer's target list yet — see the filed follow-up about adding it. `uvicorn` loads code once at boot, so finish every code rollout with `kubectl --kubeconfig "$KC" rollout restart deployment/email-classifier -n email-agent`.
- **Model (versioned, rollback-safe)**: re-run the training pipeline on the laptop, then ship the new bundle WITHOUT the one-shot populate pod (the venv already exists on the PVC):

  ```sh
  KC=~/kubeconfig-homelab
  POD=$(kubectl --kubeconfig "$KC" get pods -n email-agent -l app=email-classifier \
    -o jsonpath='{.items[0].metadata.name}')
  NEW=model-v1.5-$(date -u +%Y%m%d-%H%M)

  cd "$EMAIL_CLASSIFIER_HOME/artifacts" && tar -czf /tmp/model.tgz model
  kubectl --kubeconfig "$KC" exec -i -n email-agent "$POD" -- \
    sh -c 'mkdir -p /state/incoming && cat > /state/incoming/model.tgz' </tmp/model.tgz

  kubectl --kubeconfig "$KC" exec -n email-agent "$POD" -- sh -c "
    cd /state/ec-home/artifacts
    mkdir $NEW && tar -xzf /state/incoming/model.tgz -C $NEW --strip-components=1
    rm /state/incoming/model.tgz
    ln -sfn $NEW model   # promote: flip the default symlink
  "
  kubectl --kubeconfig "$KC" rollout restart deployment/email-classifier -n email-agent
  ```

  `artifacts/model` is a symlink to the promoted version dir; every prior version dir stays on the PVC. **Rollback** is therefore two commands and needs no code change (the API serves both bundle generations):

  ```sh
  kubectl --kubeconfig "$KC" exec -n email-agent "$POD" -- \
    sh -c 'cd /state/ec-home/artifacts && ln -sfn model-v1-20261119-0827 model'
  kubectl --kubeconfig "$KC" rollout restart deployment/email-classifier -n email-agent
  ```

  The first deployment of this scheme promoted `model-v1.5-20261119-0920` over `model-v1-20261119-0827` (2026-11-19): respond F1 0.314 → 0.528 on the standing split, archive F1 guardrail held at 0.93. The neural candidate (Qwen2.5-0.5B LoRA) scored 0.390 respond F1 on the same split and did not deploy — eval numbers decide.
