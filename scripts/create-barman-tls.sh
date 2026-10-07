#!/bin/sh
# Create the mTLS Secrets the Barman Cloud CNPG-I plugin needs
# (deploy/cnpg/barman). The operator (internal/controller/plugin_controller.go)
# uses the client pair as its gRPC client certificate and trusts the server
# certificate itself; the plugin server requires the same client cert. The
# certs are self-signed leaves — the same shape cert-manager's selfSigned
# issuer produces — so no cert-manager is needed. Idempotent; never logs key
# material.
#
# Usage:
#   ./scripts/create-barman-tls.sh            # skip if the Secrets exist
#   ./scripts/create-barman-tls.sh --force    # regenerate and roll the plugin
# Rotation: re-run with --force (10-year validity; rotate on suspicion, not on
# a clock). Needs kubectl + openssl.
set -eu

NS=cnpg-system
SERVER_SECRET=barman-cloud-server-tls
CLIENT_SECRET=barman-cloud-client-tls
# Long-lived on purpose: nothing renews self-signed leaves automatically.
DAYS=3650

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
command -v openssl >/dev/null 2>&1 || fail "openssl not found"

FORCE=0
case "${1:-}" in
  '') ;;
  --force) FORCE=1 ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac

if [ "$FORCE" -eq 0 ] &&
  kubectl -n "$NS" get secret "$SERVER_SECRET" >/dev/null 2>&1 &&
  kubectl -n "$NS" get secret "$CLIENT_SECRET" >/dev/null 2>&1; then
  echo "==> $SERVER_SECRET and $CLIENT_SECRET already exist; nothing to do (use --force to rotate)"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Self-signed leaf = its own trust anchor, which is exactly how the operator
# consumes the server secret (cert pool = the secret's tls.crt) and how the
# plugin pins client certs (--client-cert points at the client leaf).
gen_cert() { # name cn extra_ext...
  name=$1
  cn=$2
  shift 2
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -subj "/CN=$cn" -addext "subjectAltName=DNS:$cn" "$@" \
    -keyout "$tmpdir/$name.key" -out "$tmpdir/$name.crt" 2>/dev/null
}

gen_cert server barman-cloud \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
gen_cert client barman-cloud-client \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=clientAuth"

# type kubernetes.io/tls validates tls.crt/tls.key and tolerates ca.crt, so
# the Secrets read like cert-manager output (ca.crt = the leaf itself).
kubectl -n "$NS" create secret generic "$SERVER_SECRET" \
  --type=kubernetes.io/tls \
  --from-file=tls.crt="$tmpdir/server.crt" \
  --from-file=tls.key="$tmpdir/server.key" \
  --from-file=ca.crt="$tmpdir/server.crt" \
  --dry-run=client -o yaml |
  kubectl apply -f - >/dev/null

kubectl -n "$NS" create secret generic "$CLIENT_SECRET" \
  --type=kubernetes.io/tls \
  --from-file=tls.crt="$tmpdir/client.crt" \
  --from-file=tls.key="$tmpdir/client.key" \
  --from-file=ca.crt="$tmpdir/client.crt" \
  --dry-run=client -o yaml |
  kubectl apply -f - >/dev/null

echo "==> $SERVER_SECRET and $CLIENT_SECRET created in $NS"
if [ "$FORCE" -eq 1 ]; then
  # Restart so the plugin drops its old server cert at once; the operator
  # re-registers on the Secret change (and at its next restart).
  kubectl -n "$NS" rollout restart deploy/barman-cloud
  kubectl -n "$NS" rollout status deploy/barman-cloud
  echo "==> rotated. Restart the operator to re-register the plugin:"
  echo "    kubectl -n $NS rollout restart deploy/cnpg-controller-manager"
fi
echo "==> verify: kubectl -n $NS get secret $SERVER_SECRET $CLIENT_SECRET"
