#!/bin/sh
# Shared pinned private-skills sync (homelab#81, design in #69). One
# implementation consumed by every agent harness (Hermes, T3 Code, factory
# workers) in driver mode or as a sourced library:
#
#   fetch    Read-only token auth (GITHUB_TOKEN_FILE / GITHUB_TOKEN / GH_TOKEN)
#            answered through a throwaway GIT_ASKPASS helper. The token never
#            appears in a clone URL, so no credential is persisted in Git
#            config, FETCH_HEAD, or the emitted metadata.
#   verify   SKILLS_REF must be a full 40-hex commit SHA, a tag, or a branch.
#            A pinned SHA is verified (resolved HEAD must equal the request)
#            and the resolved commit is recorded in SKILLS_STATUS_FILE.
#   install  Only SKILLS_ALLOWLIST paths are installed, into an isolated
#            generated store (SKILLS_TARGET) rebuilt stage-then-swap on every
#            run: idempotent, and obsolete files from earlier syncs are
#            removed. Public skills (SKILLS_PUBLIC_DIR, e.g. a pinned P-Stack
#            checkout) are merged FIRST and allowlisted private skills SECOND,
#            so private deterministically shadows public on collision (#69).
#   scan     Staged content is refused when it looks like a credential.
#
# Failure policy lives with the caller: this library exits non-zero after
# recording SKILLS_STATUS_FILE ({ok:false,error}); interactive harnesses
# degrade loudly, ephemeral ones record the failure in run metadata.
#
# Driver mode (env-configured):
#   SKILLS_REF=<sha|tag|branch> SKILLS_ALLOWLIST="cat/name ..." \
#   SKILLS_TARGET=/path/store sh skills-lib.sh
#   SKILLS_LINK_DIRS=/harness/skills:/other  symlinks each synced skill into
#     these dirs after a successful sync; only links owned by this library
#     are ever created, refreshed, or removed — real user files are skipped.
# Source mode: `. skills-lib.sh` then call skills_sync / skills_link_generated.

SKILLS_SECRET_PATTERN='(github_pat_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|tskey-auth-)'

# Strip characters that would break a single-line JSON string.
skills_clean() {
  printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037'
}

# skills_write_status ok [commit] [error] [skill_count]
skills_write_status() {
  _ok="$1" _commit="${2:-}" _error="${3:-}" _count="${4:-}"
  _file="${SKILLS_STATUS_FILE:-}"
  [ -n "$_file" ] || return 0
  _now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    printf '{"time":"%s","ref":"%s","commit":"%s","ok":%s' \
      "$_now" "$(skills_clean "${SKILLS_REF:-}")" \
      "$(skills_clean "$_commit")" "$_ok"
    if [ -n "${SKILLS_TARGET:-}" ]; then
      printf ',"target":"%s"' "$(skills_clean "$SKILLS_TARGET")"
    fi
    if [ -n "$_count" ]; then printf ',"skills":%s' "$_count"; fi
    if [ -n "$_error" ]; then printf ',"error":"%s"' "$_error"; fi
    printf '}\n'
  } > "$_file" || return 1
  printf 'skills-sync status: %s\n' "$(cat "$_file")"
}

skills_fail() {
  _msg="$(skills_clean "$1" | cut -c1-500)"
  echo "skills-sync FAILED: $_msg" >&2
  skills_write_status false "" "$_msg" || true
  return 1
}

skills_env_check() {
  SKILLS_TARGET="${SKILLS_TARGET:-}"
  SKILLS_REF="${SKILLS_REF:-}"
  SKILLS_REPO_URL="${SKILLS_REPO_URL:-https://github.com/gwkline/.dotfiles}"
  SKILLS_SRC_PREFIX="${SKILLS_SRC_PREFIX:-skills}"
  SKILLS_WORKDIR="${SKILLS_WORKDIR:-/tmp/skills-sync-repo}"
  if [ -z "$SKILLS_TARGET" ] || [ -z "$SKILLS_REF" ]; then
    echo "skills-sync FAILED: SKILLS_TARGET and SKILLS_REF are required" >&2
    return 1
  fi
  # A ref can never contain whitespace; strip CM/env padding and refuse the rest.
  SKILLS_REF="$(printf '%s' "$SKILLS_REF" | tr -d '[:space:]')"
  if [ -z "$SKILLS_REF" ]; then
    echo "skills-sync FAILED: SKILLS_REF is empty" >&2
    return 1
  fi
  case "$SKILLS_REF" in
    *[!A-Za-z0-9._-]*)
      echo "skills-sync FAILED: SKILLS_REF has unsafe characters" >&2
      return 1
      ;;
  esac
  if [ -z "${SKILLS_STATUS_FILE:-}" ]; then
    SKILLS_STATUS_FILE="$(dirname "$SKILLS_TARGET")/skills-sync/status.json"
  fi
  mkdir -p "$(dirname "$SKILLS_STATUS_FILE")" || return 1
  mkdir -p "$(dirname "$SKILLS_TARGET")" || return 1
  return 0
}

skills_auth_token() {
  # Only http(s) remotes need the token; file:// (tests) and ssh do not.
  case "$SKILLS_REPO_URL" in
    http://*|https://*) ;;
    *) SKILLS_TOKEN_SESSION=""; return 0 ;;
  esac
  _tok=""
  if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
    _tok="$(tr -d '[:space:]' < "$GITHUB_TOKEN_FILE")"
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    _tok="$GITHUB_TOKEN"
  elif [ -n "${GH_TOKEN:-}" ]; then
    _tok="$GH_TOKEN"
  fi
  if [ -z "$_tok" ]; then
    skills_fail "no credentials for $SKILLS_REPO_URL (set GITHUB_TOKEN_FILE, GITHUB_TOKEN, or GH_TOKEN)"
    return 1
  fi
  SKILLS_TOKEN_SESSION="$_tok"
  return 0
}

skills_fetch_repo() {
  _repo="$SKILLS_WORKDIR"
  _err="$(mktemp)" || { skills_fail "mktemp failed"; return 1; }
  rm -rf "$_repo" 2>/dev/null || true
  mkdir -p "$_repo" || { skills_fail "cannot create workdir $_repo"; return 1; }
  if ! git init -q "$_repo" 2>/dev/null; then
    skills_fail "git init failed in $_repo (git missing?)"
    return 1
  fi
  if ! git -C "$_repo" remote add origin "$SKILLS_REPO_URL" 2>/dev/null; then
    skills_fail "git remote add failed for $SKILLS_REPO_URL"
    return 1
  fi
  # Throwaway askpass: git's credential prompts are answered from the runtime
  # token, so the remote URL stays clean and no credential can reach Git
  # config, FETCH_HEAD, or any other persisted file (homelab#81).
  _ap="$(mktemp)" || { skills_fail "mktemp failed"; return 1; }
  {
    echo '#!/bin/sh'
    echo 'case "$1" in'
    echo '  Username*) echo x-access-token ;;'
    echo '  Password*) printf %s "$SKILLS_TOKEN_SESSION" ;;'
    echo 'esac'
  } > "$_ap"
  # mktemp creates mode 600: without the exec bit the child git process (and
  # any non-root UID, e.g. the factory worker's `node` user) gets
  # "cannot exec ...: Permission denied". workspace-lib.sh already does this.
  chmod 700 "$_ap" || { skills_fail "chmod askpass helper failed"; return 1; }
  _rc=0
  GIT_ASKPASS="$_ap" GIT_TERMINAL_PROMPT=0 \
    git -C "$_repo" fetch -q --depth 1 origin "$SKILLS_REF" 2>"$_err" || _rc=$?
  unset SKILLS_TOKEN_SESSION
  rm -f "$_ap"
  if [ "$_rc" -ne 0 ]; then
    skills_fail "fetch of $SKILLS_REF from $SKILLS_REPO_URL failed: $(tail -c 300 "$_err" 2>/dev/null || true)"
    rm -f "$_err"
    return 1
  fi
  if ! git -C "$_repo" checkout -q --detach FETCH_HEAD 2>>"$_err"; then
    skills_fail "checkout of $SKILLS_REF failed: $(tail -c 300 "$_err" 2>/dev/null || true)"
    rm -f "$_err"
    return 1
  fi
  rm -f "$_err"
  return 0
}

skills_verify_pin() {
  _repo="$SKILLS_WORKDIR"
  SKILLS_RESOLVED_COMMIT="$(git -C "$_repo" rev-parse HEAD 2>/dev/null || true)"
  if ! printf '%s' "$SKILLS_RESOLVED_COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
    skills_fail "fetched repo has no usable commit (ref $SKILLS_REF did not resolve)"
    return 1
  fi
  # A full 40-hex ref is a pinned commit: resolved HEAD must equal it.
  _lref="$(printf '%s' "$SKILLS_REF" | tr 'ABCDEF' 'abcdef')"
  if [ "${#_lref}" -eq 40 ]; then
    _lres="$(printf '%s' "$SKILLS_RESOLVED_COMMIT" | tr 'ABCDEF' 'abcdef')"
    if [ "$_lref" != "$_lres" ]; then
      skills_fail "pinned commit mismatch: requested $SKILLS_REF, resolved $SKILLS_RESOLVED_COMMIT"
      return 1
    fi
  fi
  return 0
}

# One allowlist entry per line; blank lines and #-comments ignored.
skills_allowlist_entries() {
  printf '%s\n' "${SKILLS_ALLOWLIST:-}" | while IFS= read -r _line; do
    case "$_line" in
      ''|'#'*) continue ;;
    esac
    printf '%s\n' "$_line" | tr -s ' \t' '\n'
  done | grep -v '^$' | LC_ALL=C sort -u
}

skills_stage() {
  _staging="${SKILLS_TARGET}.staging.$$"
  SKILLS_STAGING_DIR="$_staging"
  rm -rf "${SKILLS_TARGET}".staging.* "${SKILLS_TARGET}".old.* 2>/dev/null || true
  mkdir -p "$_staging" || { skills_fail "cannot create staging dir"; return 1; }

  # 1) Public skills first (e.g. a pinned P-Stack tree, #68). Entries mirror
  #    the store layout; copied in glob (sorted) order for determinism.
  if [ -n "${SKILLS_PUBLIC_DIR:-}" ]; then
    if [ -d "$SKILLS_PUBLIC_DIR" ]; then
      for _e in "$SKILLS_PUBLIC_DIR"/*; do
        [ -e "$_e" ] || continue
        cp -a "$_e" "$_staging/" || {
          skills_fail "public skills copy failed: $_e"
          return 1
        }
      done
    else
      echo "skills-sync WARNING: SKILLS_PUBLIC_DIR=$SKILLS_PUBLIC_DIR missing — public skills skipped" >&2
    fi
  fi

  # 2) Allowlisted private skills second — they overwrite any public entry of
  #    the same path, so precedence is private > public, deterministically.
  SKILLS_INSTALLED=0
  for _name in $(skills_allowlist_entries); do
    case "$_name" in
      *[!A-Za-z0-9._/-]*|*..*|/*|*/|.*)
        skills_fail "unsafe allowlist entry: $_name"
        return 1
        ;;
    esac
    _src="$SKILLS_WORKDIR/$SKILLS_SRC_PREFIX/$_name"
    if [ ! -d "$_src" ]; then
      skills_fail "allowlisted skill missing in $SKILLS_REPO_URL@$SKILLS_REF: $SKILLS_SRC_PREFIX/$_name"
      return 1
    fi
    mkdir -p "$_staging/$(dirname "$_name")" || {
      skills_fail "staging mkdir failed for $_name"
      return 1
    }
    rm -rf "$_staging/$_name"
    cp -a "$_src" "$_staging/$_name" || {
      skills_fail "copy failed for $_name"
      return 1
    }
    SKILLS_INSTALLED=$((SKILLS_INSTALLED + 1))
  done

  # Ownership marker: everything inside SKILLS_TARGET is sync-generated.
  # (No timestamp: the marker is part of the store, and the store must stay
  # byte-identical across repeat syncs of the same ref.)
  {
    echo "generated by apps/shared/skills-lib.sh (homelab#81) — do not edit"
    echo "repo: $SKILLS_REPO_URL"
    echo "ref: $SKILLS_REF"
    echo "commit: $SKILLS_RESOLVED_COMMIT"
  } > "$_staging/.skills-sync-generated" || {
    skills_fail "marker write failed"
    return 1
  }

  # Trust gate: never install credential-looking content (#69).
  if [ "${SKILLS_SECRET_SCAN:-1}" != "0" ]; then
    _hits="$(grep -rIlE "$SKILLS_SECRET_PATTERN" "$_staging" 2>/dev/null || true)"
    if [ -n "$_hits" ]; then
      _first="$(printf '%s' "$_hits" | head -n 3 | tr '\n' ' ')"
      skills_fail "refusing to install secret-looking content in: $_first"
      return 1
    fi
  fi
  return 0
}

skills_swap() {
  _staging="$SKILLS_STAGING_DIR"
  _old="${SKILLS_TARGET}.old.$$"
  if [ -e "$SKILLS_TARGET" ]; then
    mv "$SKILLS_TARGET" "$_old" || {
      skills_fail "store swap failed (could not rename aside)"
      return 1
    }
  fi
  if ! mv "$_staging" "$SKILLS_TARGET"; then
    skills_fail "store swap failed (could not move staging in)"
    if [ -e "$_old" ]; then mv "$_old" "$SKILLS_TARGET" || true; fi
    return 1
  fi
  # Whole-store replacement is what removes obsolete generated files and
  # makes repeated syncs idempotent.
  rm -rf "$_old" 2>/dev/null || true
  return 0
}

skills_sync() {
  skills_env_check || return 1
  skills_auth_token || return 1
  skills_fetch_repo || return 1
  skills_verify_pin || return 1
  skills_stage || return 1
  skills_swap || return 1
  SKILLS_STORE_COUNT="$(find "$SKILLS_TARGET" -type f -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
  skills_write_status true "$SKILLS_RESOLVED_COMMIT" "" "$SKILLS_STORE_COUNT" || return 1
  echo "skills-sync OK: ref=$SKILLS_REF commit=$(printf '%s' "$SKILLS_RESOLVED_COMMIT" | cut -c1-7) skills=$SKILLS_STORE_COUNT target=$SKILLS_TARGET"
  return 0
}

# skills_link_generated <store> <linkdir>
# Expose the generated store to a harness skill dir via symlinks that mirror
# the store layout. Only links owned by this library (pointing into the
# store) are created or removed; real user files and foreign symlinks are
# reported and left untouched. Dangling store links are stale removals.
skills_link_generated() {
  _store="$1" _link="$2"
  if [ ! -d "$_store" ]; then
    echo "skills-sync WARNING: link source store $_store missing — nothing to link" >&2
    return 1
  fi
  mkdir -p "$_link" || {
    echo "skills-sync WARNING: cannot create $_link" >&2
    return 1
  }
  find "$_store" -type f -name SKILL.md 2>/dev/null | LC_ALL=C sort | \
  while IFS= read -r _f; do
    _rel_dir="$(dirname "${_f#"$_store"/}")"
    _dest="$_link/$_rel_dir"
    if [ -L "$_dest" ]; then
      _tgt="$(readlink "$_dest" 2>/dev/null || true)"
      case "$_tgt" in
        "$_store"/*) continue ;;
        *)
          echo "skills-sync WARNING: $_dest is a foreign symlink — left untouched" >&2
          continue
          ;;
      esac
    elif [ -e "$_dest" ]; then
      echo "skills-sync WARNING: $_dest is a real user file — NOT overwritten (skill skipped)" >&2
      continue
    fi
    mkdir -p "$(dirname "$_dest")" || {
      echo "skills-sync WARNING: mkdir $(dirname "$_dest") failed" >&2
      continue
    }
    ln -sfn "$_store/$_rel_dir" "$_dest" || \
      echo "skills-sync WARNING: link $_dest failed" >&2
  done
  find "$_link" -type l 2>/dev/null | LC_ALL=C sort | \
  while IFS= read -r _l; do
    _tgt="$(readlink "$_l" 2>/dev/null || true)"
    case "$_tgt" in
      "$_store"/*)
        if [ ! -e "$_l" ]; then
          rm -f "$_l" && echo "skills-sync: removed stale link $_l"
        fi
        ;;
    esac
  done
  return 0
}

skills_main() {
  if ! skills_sync; then
    return 1
  fi
  if [ -n "${SKILLS_LINK_DIRS:-}" ]; then
    for _d in $(printf '%s' "$SKILLS_LINK_DIRS" | tr ':' ' '); do
      [ -n "$_d" ] || continue
      skills_link_generated "$SKILLS_TARGET" "$_d" || true
    done
  fi
  return 0
}

case "$0" in
  *skills-lib.sh)
    skills_main "$@"
    exit $?
    ;;
esac
