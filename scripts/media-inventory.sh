#!/bin/sh
# Media-server hardware inventory for issue #89 (Plex vs Jellyfin prep).
#
# Run on EACH node (server + every agent) and paste the output into the
# inventory tables in docs/media-server-brief.md:
#
#   ssh <user>@<node-ip> 'sudo sh -s' < scripts/media-inventory.sh > "inv-<node>.txt"
#
# sudo is needed for SMART reads; everything else works as a normal user.
# Missing tools print an install hint instead of failing, so one run also
# tells you what the media server will need (smartmontools, ethtool, vainfo).
#
# Optional benchmark against a representative media file (measures a
# direct-play-like sequential read and a 10 s transcode; vaapi when a render
# node exists):
#
#   BENCH_FILE=/path/to/sample.mkv ./media-inventory.sh
set -u

BENCH_FILE="${BENCH_FILE:-}"
BENCH_SECS="${BENCH_SECS:-10}"
BENCH_SKIP="${BENCH_SKIP:-60}"

section() { printf '\n==== %s ====\n' "$1"; }
note()   { printf '  %s\n' "$1"; }
hint()   { printf '  (missing %s — install it to collect this data point)\n' "$1"; }
run() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@"
  else
    hint "$1"
  fi
}

section 'Host'
hostname
run uname -a
run grep PRETTY_NAME /etc/os-release
note "uptime seconds: $(cat /proc/uptime 2>/dev/null | cut -d' ' -f1)"
note "running as uid $(id -u) ($(id -un)); group $(id -gn)"

section 'CPU / RAM'
grep -m1 'model name' /proc/cpuinfo || note 'cpu model not found'
note "cores: $(grep -c processor /proc/cpuinfo)"
grep -m1 MemTotal /proc/meminfo

section 'Disks / filesystem / capacity'
run lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL
note '-- mounted filesystems --'
df -hT 2>/dev/null | grep -Ev 'tmpfs|devtmpfs|squashfs|overlay|udev' || df -h
note '-- /etc/fstab --'
grep -Ev '^[[:space:]]*(#|$)' /etc/fstab 2>/dev/null || note 'no fstab entries'
note '-- volume managers --'
command -v pvs >/dev/null 2>&1 && pvs && vgs || true
if command -v zpool >/dev/null 2>&1; then
  zpool status || true
else
  note 'no zpool (no ZFS)'
fi
command -v btrfs >/dev/null 2>&1 && btrfs filesystem show 2>/dev/null || true

section 'SMART health (sudo + smartmontools)'
if command -v smartctl >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then
    note 're-run with sudo to read SMART data'
  else
    for d in /sys/block/*; do
      b="$(basename "$d")"
      case "$b" in
        loop*|ram*|zram*|dm-*|sr*) continue ;;
      esac
      note "-- /dev/$b --"
      smartctl -H "/dev/$b" 2>/dev/null | grep -Ei 'result|health' \
        || note 'no SMART reply (USB bridge? NVMe passthrough issue?)'
    done
  fi
else
  hint smartmontools
fi

section 'Network'
run ip -br link
note '-- advertised link speeds --'
for n in /sys/class/net/*; do
  i="$(basename "$n")"
  case "$i" in lo) continue ;; esac
  s="$(cat "$n/speed" 2>/dev/null)" || s='?'
  note "$i: ${s} Mbps"
done
if command -v iperf3 >/dev/null 2>&1; then
  note 'iperf3 present — measure client<->node with: iperf3 -s / iperf3 -c <node-ip> -t 10'
else
  hint iperf3
fi

section 'GPU / iGPU / /dev/dri'
run lspci -nn | grep -Ei 'vga|display|3d controller' || note 'no lspci or no display controller'
if ls /dev/dri >/dev/null 2>&1; then
  ls -l /dev/dri
  for r in /dev/dri/renderD*; do
    [ -e "$r" ] || continue
    note "$r render group gid: $(stat -c '%g' "$r")  (pod supplementalGroups must include this)"
  done
else
  note '/dev/dri absent — no KMS driver, hardware transcode impossible'
fi
if grep -q nomodeset /proc/cmdline 2>/dev/null; then
  note 'WARNING: nomodeset in kernel cmdline — this is why /dev/dri may be missing'
fi
note '-- loaded drm modules --'
lsmod 2>/dev/null | grep -E '^(i915|xe|amdgpu|nouveau|nvidia)' || note 'no i915/amdgpu/nouveau/nvidia module loaded'
run vainfo 2>/dev/null | head -n 12 || true

section 'Benchmark'
if [ -z "$BENCH_FILE" ]; then
  note 'skipped — set BENCH_FILE=/path/to/sample.mkv to measure a workload'
else
  if [ ! -r "$BENCH_FILE" ]; then
    note "cannot read ${BENCH_FILE}"
  else
    note "-- direct-play proxy: sequential read of ${BENCH_FILE} --"
    dd if="$BENCH_FILE" of=/dev/null bs=1M 2>&1 | grep -E 'copied|bytes' || true
    if command -v ffmpeg >/dev/null 2>&1; then
      out="/tmp/media-bench.$$.$BENCH_SECS.mp4"
      note "-- software transcode: ${BENCH_SECS}s -> 720p h264/aac --"
      ffmpeg -hide_banner -nostats -ss "$BENCH_SKIP" -t "$BENCH_SECS" \
        -i "$BENCH_FILE" -vf scale=1280:720 -c:v libx264 -preset veryfast -crf 20 \
        -c:a aac -y "$out" 2>&1 | grep -E 'fps=|speed=' | tail -n 2
      rm -f "$out"
      if [ -e /dev/dri/renderD128 ]; then
        note '-- vaapi transcode (same sample) --'
        ffmpeg -hide_banner -nostats -vaapi_device /dev/dri/renderD128 \
          -ss "$BENCH_SKIP" -t "$BENCH_SECS" -i "$BENCH_FILE" \
          -vf format=nv12,hwupload -c:v h264_vaapi -c:a aac -y "$out" 2>&1 \
          | grep -E 'fps=|speed=' | tail -n 2
        rm -f "$out"
      else
        note 'vaapi skipped: no /dev/dri/renderD128'
      fi
    else
      hint ffmpeg
    fi
  fi
fi

section 'End of inventory'
note 'paste sections above into docs/media-server-brief.md for this node'