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

- **API code**: merge a PR; the ConfigMap hash changes and a routine `kubectl apply -k deploy/email-classifier/base` (or `clusters/home`) rolls the deployment. This base is NOT in the deployer's target list yet — see the filed follow-up about adding it.
- **Model**: re-run the training pipeline on the laptop, then repeat steps 3-4 above (the populate script is idempotent: it rebuilds the venv and overwrites the artifacts).
