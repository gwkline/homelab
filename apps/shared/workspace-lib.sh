#!/bin/sh
# Shared workspace plumbing, sourced by t3code and loop-agent entrypoints.
# Expects optional env:
#   GITHUB_TOKEN_FILE  path to a mounted Secret containing a fine-grained PAT
#   GITHUB_TOKEN       raw PAT fallback (prefer the mounted file)

setup_git_auth() {
  _token=""
  if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
    _token="$(cat "${GITHUB_TOKEN_FILE}")"
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    _token="${GITHUB_TOKEN}"
  fi

  [ -z "${_token}" ] && return 0

  _askpass="$(mktemp)"
  # shellcheck disable=SC2016  # writes literal $1 into the generated helper
  {
    echo '#!/bin/sh'
    echo 'case "$1" in'
    echo '  Username*) echo "x-access-token" ;;'
    echo '  Password*) cat <<"__TOK__"' 
    printf '%s\n' "${_token}"
    echo '__TOK__'
    echo '  ;;'
    echo 'esac'
  } > "${_askpass}"
  chmod 700 "${_askpass}"
  export GIT_ASKPASS="${_askpass}"
  unset _token
}

# Optional: expose a write-scoped token to the gh CLI for loops that report
# back into GitHub (comments, issue updates). No-op unless the operator
# mounts secret github-token-writer and sets GITHUB_WRITER_TOKEN_FILE.
setup_gh_cli() {
  if [ -n "${GITHUB_WRITER_TOKEN_FILE:-}" ] && [ -r "${GITHUB_WRITER_TOKEN_FILE}" ]; then
    GH_TOKEN="$(cat "${GITHUB_WRITER_TOKEN_FILE}")"
    export GH_TOKEN
  fi
}

sync_repos() {
  _repos_dir="${DATA_DIR:-/data}/repos"
  mkdir -p "${_repos_dir}"

  for url in ${WORKSPACE_REPOS:-}; do
    _name="$(basename "${url}" .git)"
    _dest="${_repos_dir}/${_name}"

    if [ -d "${_dest}/.git" ]; then
      echo "[workspace] updating ${_name}"
      git -C "${_dest}" pull --ff-only \
        || echo "[workspace] WARN: pull failed for ${_name}, keeping existing copy"
    else
      echo "[workspace] cloning ${url}"
      git clone "${url}" "${_dest}" \
        || echo "[workspace] ERROR: clone failed for ${url} (private? check the github-token secret)"
    fi
  done
}
