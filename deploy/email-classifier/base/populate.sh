#!/bin/sh
# One-time state bootstrap for email-classifier. Runs inside the populate pod
# (../populate/populate.yaml) after `kubectl apply -k ..` (this base).
# Builds the venv on the state PVC, then waits for the operator to pipe the
# Gmail-derived model tarball in (it must never travel through git or GHCR):
#
#   kubectl exec -i -n email-agent email-classifier-populate -- \
#     sh -c 'cat > /state/incoming/model.tgz' < model.tgz
#
# The tarball must contain a top-level model/ directory (model.joblib,
# metadata.json, embedding-model/) as produced by src/train.py.
set -eu

STATE=/state
mkdir -p "$STATE/incoming"

python3 -m venv "$STATE/venv"
"$STATE/venv/bin/pip" install --no-cache-dir --upgrade pip >/dev/null
# CPU-only torch: the default linux wheel drags ~4GB of CUDA libraries in.
"$STATE/venv/bin/pip" install --no-cache-dir torch \
	--index-url https://download.pytorch.org/whl/cpu
"$STATE/venv/bin/pip" install --no-cache-dir -r /scripts/requirements.txt
echo "venv ready; waiting for $STATE/incoming/model.tgz"

i=0
while [ ! -s "$STATE/incoming/model.tgz" ]; do
	i=$((i + 1))
	if [ "$i" -gt 720 ]; then
		echo "no model.tgz after 1h; giving up" >&2
		exit 1
	fi
	sleep 5
done

mkdir -p "$STATE/ec-home/artifacts"
tar -xzf "$STATE/incoming/model.tgz" -C "$STATE/ec-home/artifacts"
rm -f "$STATE/incoming/model.tgz"
"$STATE/venv/bin/python" - <<'PY'
import joblib

bundle = joblib.load("/state/ec-home/artifacts/model/model.joblib")
print("model loaded:", bundle["version"])
PY
echo POPULATE_DONE
