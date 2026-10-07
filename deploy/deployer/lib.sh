#!/bin/sh
# Functions for deploy.sh, sourced; tests/deploy.test.sh covers them offline.

# select_kinds KIND...: the documents of the YAML stream on stdin whose
# top-level kind is one of KIND.
select_kinds() {
  awk -v kinds=" $* " '
    function flush() {
      if (index(kinds, " " kind " ")) printf "---\n%s", doc
      doc = ""
      kind = ""
    }
    /^---/ { flush(); next }
    /^kind:/ { kind = $2 }
    { doc = doc $0 "\n" }
    END { flush() }
  '
}

# pin_image REF DIGEST FILE: rewrites every REF (an image:tag) in FILE to the
# image at DIGEST.
pin_image() {
  sed "s|$1|${1%:*}@$2|g" "$3" >"$3.tmp"
  mv "$3.tmp" "$3"
}

# ghcr_digest REPO TAG: the digest ghcr.io/REPO:TAG points at, via an
# anonymous pull token (the packages are public). Empty if the tag is missing.
ghcr_digest() {
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$1:pull" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  curl -fsSI -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$1/manifests/$2" |
    tr -d '\r' | sed -n 's/^docker-content-digest: //Ip'
}
