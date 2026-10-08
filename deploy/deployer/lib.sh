#!/bin/sh
# Functions for deploy.sh, sourced; tests/deploy.test.sh covers them offline.

# short SHA: the 7-character form CI tags images with (sha-<short>).
short() {
  printf '%.7s\n' "$1"
}

# ci_runs: reads the GitHub workflow-runs JSON on stdin and prints one line
# per run, newest first: "<head sha> <status> <conclusion>".
ci_runs() {
  node -e '
    const { workflow_runs } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const r of workflow_runs) console.log(r.head_sha, r.status, r.conclusion ?? "none");
  '
}

# ci_state SHA RUNS: the newest CI run of SHA, as its conclusion or, while it
# runs, its status.
ci_state() {
  awk -v sha="$1" '
    $1 == sha { print ($2 == "completed" ? $3 : $2); found = 1; exit }
    END { if (!found) print "not started" }
  ' "$2"
}

# newest_green COMMITS GREEN: the first commit in COMMITS (newest first) that
# GREEN lists. Fails if there is none.
newest_green() {
  awk '
    FILENAME == ARGV[1] { green[$1] = 1; next }
    $1 in green { print $1; found = 1; exit }
    END { exit !found }
  ' "$2" "$1"
}

# build_tag SHA COMMITS GREEN TAGS: the image tag to deploy at SHA. That is
# sha-<short> of the newest commit at or before SHA in COMMITS (newest first)
# that GREEN lists and TAGS has a tag for. CI rebuilds an image only when its
# inputs changed since the last green run, so that build has SHA's inputs.
# Fails if there is none.
build_tag() {
  awk -v sha="$1" '
    FILENAME == ARGV[1] { green[$1] = 1; next }
    FILENAME == ARGV[2] { tags[$1] = 1; next }
    $1 == sha { reached = 1 }
    reached && ($1 in green) && (("sha-" substr($1, 1, 7)) in tags) {
      print "sha-" substr($1, 1, 7)
      found = 1
      exit
    }
    END { exit !found }
  ' "$3" "$4" "$2"
}

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

# workloads: "<namespace> <kind>/<name>" for each Deployment and StatefulSet
# in the YAML stream on stdin, as kubectl rollout status takes them.
workloads() {
  awk '
    function flush() {
      if (kind == "Deployment" || kind == "StatefulSet") print ns, tolower(kind) "/" name
      kind = ""
      name = ""
      ns = ""
    }
    /^---/ { flush(); next }
    /^[^ ]/ { meta = /^metadata:/ }
    /^kind:/ { kind = $2 }
    meta && /^  name:/ { name = $2 }
    meta && /^  namespace:/ { ns = $2 }
    END { flush() }
  '
}

# pin_image REF DIGEST FILE: rewrites every REF (an image:tag) in FILE to the
# image at DIGEST.
pin_image() {
  sed "s|$1|${1%:*}@$2|g" "$3" >"$3.tmp"
  mv "$3.tmp" "$3"
}

# ghcr_token REPO: an anonymous pull token; the packages are public.
ghcr_token() {
  curl -fsS "https://ghcr.io/token?scope=repository:$1:pull" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

# ghcr_build_tags REPO: the sha-<short> tags of ghcr.io/REPO, one per line,
# following the registry's pagination.
ghcr_build_tags() {
  token=$(ghcr_token "$1")
  page=$(mktemp)
  next="/v2/$1/tags/list?n=1000"
  while [ -n "$next" ]; do
    curl -fsS -D "$page.headers" -o "$page" \
      -H "Authorization: Bearer ${token}" "https://ghcr.io${next}" || return 1
    grep -oE '"sha-[0-9a-f]+"' "$page" | tr -d '"'
    next=$(tr -d '\r' <"$page.headers" | sed -n 's/^link: <\([^>]*\)>.*/\1/Ip')
  done
  rm -f "$page" "$page.headers"
}

# ghcr_digest REPO TAG: the digest ghcr.io/REPO:TAG points at; empty if the
# tag doesn't exist.
ghcr_digest() {
  token=$(ghcr_token "$1")
  curl -fsSI -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$1/manifests/$2" |
    tr -d '\r' | sed -n 's/^docker-content-digest: //Ip'
}
