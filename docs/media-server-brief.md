# Media server deployment brief (Plex vs Jellyfin)

**Status:** research only — implements the fact-gathering part of issue #89. **Nothing deploys yet**: per issue #89, deployment waits until fast recovery from issue #34 is proven. This brief is the checklist that turns the facts below into a deployment PR later.

**Prime directive (from the issue):** no large media files on small local-path application PVCs. Those live under `/var/lib/rancher/k3s/storage`, are sized for agent homes and metadata, and get snapshotted by restic — a 4 TB media library would blow up both.

## 1. Collect the facts (per node)

Run the inventory script on **each** node over SSH and paste the output into section 2's tables:

```sh
ssh <user>@<node-ip> 'sudo sh -s' < scripts/media-inventory.sh > "inv-<node>.txt"
# with a representative media file present on that node:
# BENCH_FILE=/srv/media/sample.mkv BENCH_SECS=10 ssh <user>@<node-ip> 'sudo sh -s' \
#   < scripts/media-inventory.sh > "inv-bench-<node>.txt"
```

Missing tools print install hints (`smartmontools`, `ethtool`, `vainfo` via `intel-media-va-driver-non-free` on Intel, `ffmpeg`, `iperf3`); install them and re-run rather than guessing.

## 2. Inventory tables

**Known constraint from the rebuild runbook:** `agent-1` boots with `nomodeset` in `GRUB_CMDLINE_LINUX_DEFAULT` (headless-stability hack). That means no KMS driver → no `/dev/dri` → **hardware transcoding is impossible on agent-1 until that kernel arg is removed** (`sudo sed -i 's/ quiet splash nomodeset/ quiet splash/' /etc/default/grub && sudo update-grub && reboot`, then verify the `nomodeset` count in `/boot/grub/grub.cfg` is 0). Check on both nodes with `grep nomodeset /proc/cmdline` (the script flags it too).

| Node | Disks (model/size) | Filesystem | Free capacity | SMART | Mount strategy |
| --- | --- | --- | --- | --- | --- |
| agent-1 | TBD | TBD | TBD | TBD | TBD |
| agent-2 | TBD | TBD | TBD | TBD | TBD |

| Node | CPU (model/cores) | RAM | iGPU/GPU | `/dev/dri` | VAAPI profiles |
| --- | --- | --- | --- | --- | --- |
| agent-1 | TBD | TBD | TBD | TBD (expect: absent — nomodeset) | TBD |
| agent-2 | TBD | TBD | TBD | TBD | TBD |

| Node    | Link speed | iperf3 client→node | Notes |
| ------- | ---------- | ------------------ | ----- |
| agent-1 | TBD        | TBD                |       |
| agent-2 | TBD        | TBD                |       |

Decision rules once filled in:

- **Transcode-capable node** = `/dev/dri` exists with `renderD128`, `vainfo` lists H264/HEVC encode profiles, CPU has 4+ free cores as fallback.
- **Media-capable node** = a disk that can be dedicated to media (SMART `PASSED`, ≥ 1 TB free) with 1 GbE or better.
- If no node has both, the brief still stands: pick media-capable for storage, accept CPU-only transcoding (see section 5).

## 3. Replaceable vs irreplaceable data

| Data | Replaceable? | Backed up how | Where it lives |
| --- | --- | --- | --- |
| Media files (video/audio) | **Yes** — re-rip / re-download | **Nothing** (deliberately; a TB-scale restic repo is not worth it) | Dedicated media mount (section 4) |
| Jellyfin config + metadata (library db, watched state, users) | **No** — hours of library setup | restic, nightly (add its PVC to `deploy/backup/base/cronjob.yaml` volume list) | normal PVC via local-path |
| Plex config + metadata (`Library/Application Support/Plex Media Server`) | **No** — same reasoning | restic, nightly, same mechanism | normal PVC via local-path |
| Transcode cache | Yes (regenerates) | Nothing | tmpfs / emptyDir |

The restic CronJob currently snapshots `/mnt/t3code` and `/mnt/hermes` by explicit PVC name; the media config PVC gets appended to that list in the deployment PR, keeping the small-irreplaceable / large-replaceable split honest.

## 4. Storage design — decision

**Decision: dedicated disk on the media-capable node, ext4, fixed mount point, exposed to the pod via hostPath. Not a local-path PVC; not NFS; ZFS only if the inventory finds ≥2 spare disks and ≥16 GB RAM.**

Reasons, tied to this cluster:

- **hostPath beat**: media is replaceable, huge, and single-node by design. A hostPath bind mount (e.g. `/srv/media`) is transparent, needs no provisioner, and survives k3s reinstalls of the app but not the disk — matching the repo's "disposable nodes" model.
- **local-path PVC lost**: it would put the library under `/var/lib/rancher/k3s/storage` (grow-unbounded on the OS disk) and drag the library into any future "back up all PVCs" sweep.
- **NFS deferred**: there is no NAS in the current inventory; adding one is a new machine + failure domain for marginal benefit at two nodes. Revisit only if the library outgrows every node disk.
- **ZFS deferred**: mirrors are tempting for irreplaceable data, but media is replaceable (section 3) and ZFS ARC eats RAM these old servers don't have. ext4 + SMART monitoring + no-backup-accepted-loss is the honest trade.

Fallback if no spare disk exists: keep media on the largest existing partition but mount it via a dedicated path and **exclude it from restic** — same hostPath mechanics, no volume-manager churn.

## 5. Plex vs Jellyfin vs this tailnet's clients

| Requirement (actual clients) | Plex | Jellyfin |
| --- | --- | --- |
| Hardware (VA-API) transcoding free | No — **Plex Pass required** | Yes, built-in |
| Roku / Apple TV / Fire TV apps | Mature | Decent (Jellyfin for Roku/Android TV), fewer refinements |
| Browser / mobile clients | Excellent | Good (Jellyfin Media Player, mobile apps) |
| Works without phoning home / accounts | No (plex.tv account) | Yes — fully local |
| Remote access model | plex.tv relay or open port | Whatever you expose — here: tailnet only |

Client-device ground truth to verify before deciding (fill in yours):

| Client in the house | Direct-play needs | Transcode trigger |
| --- | --- | --- |
| Modern TV / Apple TV / Roku | H264/HEVC + AAC direct play | DTS/TrueHD audio → AAC, or HEVC 10-bit on old panels |
| Phone / laptop browsers | H264 | HEVC on some Android browsers |
| Anything legacy | H264 only | everything else |

**Recommendation: Jellyfin** — no Plex Pass tax for hardware transcoding, no account dependency, and this cluster is already tailnet-only (no public sharing, which is Plex's main edge). Choose Plex only if Plex Pass is already owned and a specific set-top client's Plex app is meaningfully better than the Jellyfin one for your hardware.

## 6. Node labels, taints, and device exposure

Media must land on exactly one node — the one with the disk and the working GPU:

```sh
kubectl label node <media-node> media=true
kubectl taint node <media-node> media=true:NoSchedule
```

Pod tolerates `media=true:NoSchedule` and gets the GPU without privileges:

```yaml
securityContext:
  runAsUser: 1000 # repo convention (README security model)
  runAsGroup: 1000
  supplementalGroups:
    - <render-gid> # stat -c '%g' /dev/dri/renderD128 on the node
volumeMounts:
  - { name: media, mountPath: /media }
  - { name: dri, mountPath: /dev/dri, readOnly: true }
volumes:
  - name: media
    hostPath: { path: /srv/media, type: Directory }
  - name: dri
    hostPath: { path: /dev/dri, type: Directory }
```

No privileged sidecar, no device plugin — a read-only `/dev/dri` bind plus the render GID is sufficient for VA-API under k3s. If the inventory shows the iGPU needs a userspace driver package not in the app image, bake it into the image rather than chown-ing devices.

Prerequisite if the chosen node is agent-1: revert `nomodeset` (section 2), reboot, re-run `scripts/media-inventory.sh`, confirm `/dev/dri` + `vainfo`.

## 7. Benchmarks (run once hardware permits)

Representative workload: one 1080p H264 file and one 4K/HEVC file if available.

```sh
BENCH_FILE=/srv/media/sample-1080p.mkv BENCH_SECS=10 \
  ssh <user>@<node-ip> 'sudo sh -s' < scripts/media-inventory.sh
# client→node throughput:  iperf3 -c <node-ip> -t 10   (server: iperf3 -s)
```

| Workload | Result | Accept line |
| --- | --- | --- |
| Direct play (sequential read of library file) | TBD | ≥ highest-bitrate file you own (e.g. 80 Mbps for a 4K remux) |
| Client→node iperf3 | TBD | ≥ same bar; tailnet-over-DERP will be lower, see section 8 |
| Software transcode 1080p→720p h264 | TBD | ≥ 1× realtime (speed ≥ 1.0) |
| VAAPI transcode 1080p→720p | TBD | ≥ 2× realtime, CPU mostly idle |

If software transcoding can't hold 1× realtime and there's no working iGPU, the library policy becomes "direct-play friendly formats only" (H264 + AAC) until hardware or the disk situation changes.

## 8. Tailnet / remote access expectations

- Exposure follows the existing pattern: a LoadBalancer Service with `loadBalancerClass: tailscale`, plus the `tailscale.com/hostname` and `tailscale.com/tags=tag:k8s-operator` annotations CI enforces (issue #92). Result: `https://jellyfin.<tailnet>.ts.net`, HTTPS cert issued by the operator.
- **No public internet exposure.** No Plex relay login, no port forward. Off-tailnet devices (phone away from home) use the Tailscale app; the media server is reachable from anywhere on the tailnet only.
- Bandwidth expectation: on-LAN clients get full 1 GbE. Off-LAN traffic usually rides a DERP relay (tens of Mbps) — direct play of high-bitrate remuxes may stutter remotely; a 4–8 Mbps 720p transcode profile is the safe remote default, which is another reason a working transcoder matters.
- Homeassistant-style port forwarding / DMZ: not part of this plan.

## 9. Storage sizes, permissions, restore plan

| Path | Size | Owner/perms | Contents |
| --- | --- | --- | --- |
| `/srv/media` (hostPath → `/media` in pod) | full spare disk (TBD from section 2) | `1000:1000`, `0775` dirs / `0664` files | media library, replaceable |
| media-config PVC | 10 Gi | `1000:1000` | app config + metadata (irreplaceable) |
| transcode cache | emptyDir (ephemeral) | — | scratch, sized ≤ 10 GB |

The media directory is created once per node (`sudo mkdir -p /srv/media && sudo chown 1000:1000 /srv/media`) — if it's on a dedicated disk, format + fstab it first, then apply the same ownership.

**Restore plan**

1. **Config/metadata (RPO: nightly, RTO: minutes):** PVC is in the restic snapshot list → restore with the existing snippet from `docs/runbook-server-cluster.md` section 11 (`restic restore latest --include /mnt/<media-config>`), then reapply the workload from git.
2. **Media (RPO: none, accepted loss):** the library re-rip / re-download is the restore procedure; the node's mount + permissions are re-created from the commands above.
3. **Node loss:** media is single-node by design — if that node's disk dies, the library is re-seeded from source. Config PVCs are restorable from B2. Document which node holds `/srv/media` in the tables above once chosen.

## 10. Next steps (blocked on #34)

- [ ] Run `scripts/media-inventory.sh` on both nodes, fill section 2 tables
- [ ] Revert `nomodeset` on the media node if present (section 2 note)
- [ ] Pick node → label + taint (section 6); provision `/srv/media`
- [ ] Run benchmarks, fill section 7, confirm transcode capability
- [ ] Only after #34 is proven: deployment PR — Jellyfin StatefulSet, config PVC, hostPath media, tailscale-annotated Service, restic list update
