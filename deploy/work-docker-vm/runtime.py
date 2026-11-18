#!/usr/bin/env python3
"""Host runtime: mount gates, isolated QEMU, source-set refresh and mTLS ports.

Configuration and credentials are private runtime files, never repository data.
"""
import argparse
import asyncio
import ipaddress
import json
import os
from pathlib import Path
import socket
import stat
import ssl
import struct
import subprocess
import time
import urllib.request

UNIT = "work-dockervm.service"
INHIBIT = Path("/var/lib/work-docker-vm/inhibited")


def mount(config):
    path = Path(config["mount"])
    # Resolve the UUID-labelled block identity by stat, not by opening a
    # disk/blkid probe. The VM UID has no block-device access by design.
    device = Path("/dev/disk/by-uuid") / config["uuid"]
    try:
        identity = device.stat()
    except OSError as error:
        raise RuntimeError("required filesystem UUID identity unavailable") from error
    if not path.is_mount() or not stat.S_ISBLK(identity.st_mode) or path.stat().st_dev != identity.st_rdev or path.stat().st_dev == Path("/").stat().st_dev:
        raise RuntimeError("required separate filesystem unavailable")
    return path


def available(config):
    info = os.statvfs(mount(config))
    return info.f_bavail * info.f_frsize


def start(config):
    base = mount(config)
    if INHIBIT.exists() or available(config) < config["start_gib"] * 2**30:
        raise RuntimeError("VM start inhibited or insufficient separate-filesystem headroom")
    vm = base / "vm"
    args = ["/usr/bin/qemu-system-x86_64", "-machine", "q35,accel=kvm,dump-guest-core=off,mem-merge=off",
            "-cpu", "host", "-smp", str(config["cpus"]), "-m", str(config["memory_mib"]),
            "-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none",
            "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
            "-qmp", "unix:/run/work-dockervm/qmp.sock,server=on,wait=off",
            "-serial", "file:" + str(vm / "serial.log"),
            "-drive", "file=" + str(vm / "disk.qcow2") + ",if=virtio,format=qcow2,cache=none",
            "-drive", "file=" + str(vm / "seed.iso") + ",if=virtio,format=raw,readonly=on"]
    net = "user,id=net0,ipv6=off,hostfwd=tcp:" + config["address"] + ":2376-10.0.2.15:2376"
    for port, bridge in config["ports"].items():
        net += f",hostfwd=tcp:127.0.0.1:{bridge}-10.0.2.15:{port}"
    args += ["-netdev", net, "-device", "virtio-net-pci,netdev=net0,mac=52:54:00:77:00:01"]
    for index, source in enumerate(config["sources"]):
        original = Path(source["host"])
        export = Path("/run/work-dockervm/exports") / str(index)
        if original.stat().st_dev != base.stat().st_dev or original.is_symlink():
            raise RuntimeError("source export is not on the verified filesystem")
        if not os.statvfs(export).f_flag & os.ST_RDONLY:
            raise RuntimeError("host source export is not enforced read-only")
        args += ["-fsdev", f"local,id=source{index},path={export},security_model=none,readonly=on,multidevs=forbid",
                 "-device", f"virtio-9p-pci,fsdev=source{index},mount_tag=source{index}"]
    os.execv(args[0], args)


def refresh(config, address):
    # A single nft transaction; failed refreshes expire automatically as well.
    commands = "flush set inet work_docker work_pod\n"
    if address:
        commands += f"add element inet work_docker work_pod {{ {ipaddress.IPv4Address(address)} timeout 15s }}\n"
    subprocess.run(["nft", "-f", "-"], input=commands.encode(), check=True, stdout=subprocess.DEVNULL)


def approved_pod(config, pod):
    spec, status = pod.get("spec", {}), pod.get("status", {})
    if pod.get("metadata", {}).get("name") != "work-t3code-0" or pod.get("metadata", {}).get("labels", {}).get("app") != "work-t3code":
        return None
    if spec.get("nodeName") != config["node"] or spec.get("hostNetwork", False) or spec.get("automountServiceAccountToken") is not False:
        return None
    if status.get("phase") != "Running" or not any(c.get("type") == "Ready" and c.get("status") == "True" for c in status.get("conditions", [])):
        return None
    address = ipaddress.IPv4Address(status["podIP"])
    return str(address) if address in ipaddress.IPv4Network(config["pod_cidr"]) else None


def watch(config):
    context = ssl.create_default_context(cafile=config["watch_ca"])
    while True:
        address = None
        try:
            token = Path(config["watch_token"]).read_text().strip()
            request = urllib.request.Request(config["watch_api"] + "/api/v1/namespaces/work/pods/work-t3code-0", headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(request, context=context, timeout=4) as response:
                address = approved_pod(config, json.load(response))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        try:
            refresh(config, address)
        except subprocess.CalledProcessError:
            pass  # The set's timeout remains fail-closed if nft itself fails.
        time.sleep(3)


def guard(config, fixture=None):
    try:
        value = available(config) if fixture is None else fixture
        stop = value < config["stop_gib"] * 2**30
    except (OSError, RuntimeError, subprocess.CalledProcessError):
        stop = True
    if stop:
        INHIBIT.parent.mkdir(parents=True, exist_ok=True)
        INHIBIT.write_text("separate filesystem unavailable or pressure stop\n")
        subprocess.run(["systemctl", "stop", UNIT], check=True)
        return True
    return False


def reset(config):
    if available(config) < config["start_gib"] * 2**30:
        raise RuntimeError("cannot clear inhibition below the real launch budget")
    INHIBIT.unlink(missing_ok=True)


def powerdown():
    # ACPI shutdown, not guest-agent host commands. systemd bounds termination.
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect("/run/work-dockervm/qmp.sock")
            stream = client.makefile("rwb")
            stream.readline()
            stream.write(b'{"execute":"qmp_capabilities"}\n'); stream.flush(); stream.readline()
            stream.write(b'{"execute":"system_powerdown"}\n'); stream.flush()
            deadline = time.monotonic() + 18
            while time.monotonic() < deadline:
                try:
                    if not client.recv(4096):
                        return
                except socket.timeout:
                    continue
    except (OSError, TimeoutError):
        pass


async def relay(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()


async def server_connection(reader, writer, config):
    backend = None
    try:
        # mTLS is completed before this handler; a caller can select only a
        # fixed guest-service port, never an arbitrary host address or port.
        header = await asyncio.wait_for(reader.readexactly(2), 5)
        port = str(struct.unpack("!H", header)[0])
        if port not in config["ports"]:
            return
        upstream, backend = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", config["ports"][port]), 5)
        tasks = [asyncio.create_task(relay(reader, backend)), asyncio.create_task(relay(upstream, writer))]
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        pass
    finally:
        if backend:
            backend.close()
        writer.close()


async def proxy(config):
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_verify_locations(config["server_ca"])
    context.load_cert_chain(config["server_cert"], config["server_key"])
    context.verify_mode = ssl.CERT_REQUIRED
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    server = await asyncio.start_server(lambda r, w: server_connection(r, w, config), config["address"], 2377, ssl=context, ssl_handshake_timeout=5)
    async with server:
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["start", "watch", "guard", "reset", "powerdown", "proxy"])
    parser.add_argument("config", type=Path)
    parser.add_argument("--fixture-available", type=int)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if args.mode == "start": start(config)
    elif args.mode == "watch": watch(config)
    elif args.mode == "guard": guard(config, args.fixture_available)
    elif args.mode == "reset": reset(config)
    elif args.mode == "powerdown": powerdown()
    else: asyncio.run(proxy(config))


if __name__ == "__main__":
    main()
