#!/usr/bin/env python3
"""Copy only work PVCs to an existing verified filesystem. Never edit the source.

Run on the node as an authorized administrator. Private JSON config supplies
mount, uuid and volumes [{source, destination}]. A final copy requires the
runner to be gracefully stopped; this script independently checks procfs.
It neither formats disks nor changes Kubernetes resources.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def mounted(config):
    mount = Path(config["mount"])
    uuid = subprocess.check_output(
        ["findmnt", "-n", "-o", "UUID", "--mountpoint", str(mount)], text=True
    ).strip()
    if not config["uuid"] or uuid != config["uuid"]:
        raise RuntimeError("expected filesystem is not mounted")
    if mount.stat().st_dev == Path("/").stat().st_dev:
        raise RuntimeError("root filesystem fallback forbidden")
    return mount.resolve()


def validate(config):
    mount = mounted(config)
    if len(config["volumes"]) != 2:
        raise RuntimeError("exactly two work volumes are required")
    destinations = []
    for volume in config["volumes"]:
        source = Path(volume["source"])
        destination = Path(volume["destination"])
        if source.is_symlink() or not source.is_dir():
            raise RuntimeError("source must be an existing directory")
        # Resolve parents as well: a symlink must not redirect writes elsewhere.
        if source.resolve().is_relative_to(mount):
            raise RuntimeError("source must remain on its original filesystem")
        if not destination.resolve().is_relative_to(mount):
            raise RuntimeError("destination escapes the verified mount")
        if destination.is_symlink() or destination.resolve() == mount:
            raise RuntimeError("unsafe destination")
        if destination.exists() and destination.stat().st_dev != mount.stat().st_dev:
            raise RuntimeError("nested/fallback destination filesystem forbidden")
        resolved = destination.resolve()
        if any(resolved.is_relative_to(other) or other.is_relative_to(resolved) for other in destinations):
            raise RuntimeError("overlapping destination volumes forbidden")
        destinations.append(resolved)
    return mount


def no_writers(config, proc=Path("/proc")):
    sources = [str(Path(v["source"]).resolve()) for v in config["volumes"]]
    # A surviving container with an RW bind of either old PVC is a blocker,
    # even when it happens not to have a writable FD at the instant of checking.
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            for line in (process / "mountinfo").read_text().splitlines():
                fields = line.split()
                if any(source in fields[3] or source in line for source in sources):
                    if "rw" in fields[5].split(","):
                        raise RuntimeError("source still mounted writable by a process")
            for fd in (process / "fd").iterdir():
                target = os.readlink(fd)
                if any(target == s or target.startswith(s + "/") for s in sources):
                    info = (process / "fdinfo" / fd.name).read_text()
                    flags = next(row.split()[1] for row in info.splitlines() if row.startswith("flags:"))
                    if int(flags, 8) & os.O_ACCMODE:
                        raise RuntimeError("source still has a writable descriptor")
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Do not silently skip permission-denied procfs: inability to inspect
        # all processes is not evidence that there are no writers.


def run(config, mode, audit):
    validate(config)
    audit.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A failed retry must not leave an old success receipt for this mode.
    (audit / f"{mode}.json").unlink(missing_ok=True)
    if mode != "precopy":
        no_writers(config)
    for index, volume in enumerate(config["volumes"]):
        mounted(config)  # Re-check before each potentially long transfer.
        destination = Path(volume["destination"])
        if mode != "verify":
            destination.mkdir(parents=True, exist_ok=True)
        args = ["rsync", "-aHAXS", "--numeric-ids", "--itemize-changes"]
        if mode == "precopy":
            # May race a live writer; never delete from even the new copy.
            pass
        elif mode == "final":
            # Old versions/stale precopy files are retained outside the active
            # destination. --delete only affects this explicitly new copy.
            args += ["--checksum", "--delete", "--backup", "--backup-dir=" + str(audit / f"retained-precopy-{index}")]
        else:
            args += ["--checksum", "--dry-run", "--delete"]
        args += [volume["source"].rstrip("/") + "/", str(destination) + "/"]
        log = audit / f"{mode}-{index}.log"
        with log.open("wb") as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, check=False)
        if result.returncode and not (mode == "precopy" and result.returncode == 24):
            raise RuntimeError(f"rsync {mode} failed ({result.returncode}); inspect private log")
        if mode == "verify" and log.stat().st_size:
            raise RuntimeError("checksum/metadata dry run has unexplained differences")
        mounted(config)
    if mode != "precopy":
        no_writers(config)
    (audit / f"{mode}.json").write_text(json.dumps({"mode": mode, "verified_uuid": config["uuid"], "volumes": len(config["volumes"]), "ok": True, "final_verification_required": mode != "verify"}) + "\n")
    print(f"{mode}: {len(config['volumes'])} volumes; mount verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["precopy", "final", "verify"])
    parser.add_argument("config", type=Path)
    parser.add_argument("audit", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    mount = validate(config)
    if not args.audit.resolve().is_relative_to(mount):
        raise RuntimeError("audit must reside on the verified filesystem")
    if any(args.audit.resolve().is_relative_to(Path(v["destination"]).resolve()) or Path(v["destination"]).resolve().is_relative_to(args.audit.resolve()) for v in config["volumes"]):
        raise RuntimeError("audit and destination volumes must not overlap")
    os.umask(0o077)
    run(config, args.mode, args.audit)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
