# Login shells rebuild PATH before T3 launches tools; restore work-only shims.
if [ "${WORK_RESOURCE_GUARD:-0}" = 1 ] && [ "${WORK_RESOURCE_SCOPE:-}" = work ]; then
  _work_resource_guard_bin="${WORK_GUARD_SHIM_BIN:-/tmp/work-resource-guard/bin}"
  if [ -d "$_work_resource_guard_bin" ]; then
    case "${PATH:-}" in
      "$_work_resource_guard_bin":*) ;;
      *) PATH="$_work_resource_guard_bin:${PATH:-/usr/local/bin:/usr/bin:/bin}" ;;
    esac
    export PATH
  fi
  unset _work_resource_guard_bin
fi
