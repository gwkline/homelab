#!/usr/bin/env python3
"""Render private host/guest configuration from reviewed repository code.

Run as authorized node administrator only, after verified signed cloud-image
and credential provisioning. Never formats, deletes, or modifies work sources.
"""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import pwd
import grp
import hashlib
import re
import shlex
import stat
import subprocess
import uuid

from runtime import INHIBIT, mount

ROOT = Path("/etc/work-docker-vm")
LIB = Path("/usr/local/lib/work-docker-vm")


def checked(config):
    uuid.UUID(config["uuid"])
    ipaddress.IPv4Address(config["address"])
    ipaddress.IPv4Network(config["pod_cidr"])
    if config["docker_version"] != "5:29.10.0-1~ubuntu.24.04~noble" or not re.fullmatch(r"[a-f0-9]{64}", config["docker_key_sha256"]):
        raise ValueError("unverified Docker package/key pin")
    if not config["sources"] or config["cpus"] not in (2, 4) or not 4096 <= config["memory_mib"] <= 8192:
        raise ValueError("invalid source/resource configuration")
    if config["disk_gib"] != 32 or config["start_gib"] < 35 or config["stop_gib"] < 25:
        raise ValueError("invalid independent filesystem budget")
    for source in config["sources"]:
        for key in ["host", "guest"]:
            path = Path(source[key])
            if not path.is_absolute() or ".." in path.parts or any(c in str(path) for c in "\n\r\t ,"):
                raise ValueError("unsafe literal export path")
        if not Path(source["host"]).resolve().is_relative_to(Path(config["mount"]).resolve()):
            raise ValueError("export outside intended filesystem")
        allowed = ("/data/repos/", "/home/node/.t3/worktrees/", "/data/docker-runtime-probes/")
        if not source["guest"].startswith(allowed):
            raise ValueError("authentication/state or unapproved source export forbidden")
        guest_path = Path(source["guest"])
        if guest_path.is_relative_to("/data"):
            expected = Path(config["mount"]) / "work-t3code/data" / guest_path.relative_to("/data")
        else:
            expected = Path(config["mount"]) / "work-t3code/t3state" / guest_path.relative_to("/home/node/.t3")
        if Path(source["host"]).resolve() != expected.resolve():
            raise ValueError("host/guest source mapping mismatch")
        for parent in [Path(source["host"]), *Path(source["host"]).parents]:
            if parent.is_symlink():
                raise ValueError("symlinked source ancestry forbidden")
            if parent == Path(config["mount"]):
                break
    ports = {str(int(k)): int(v) for k, v in config["ports"].items()}
    if any(str(int(k)) != k for k in config["ports"]):
        raise ValueError("noncanonical literal port identifier")
    if len(set(ports.values())) != len(ports) or any(not 1024 <= int(k) <= 65535 or int(k) in (2376, 2377, 3773, 6443) or not 40000 <= v < 40100 for k, v in ports.items()):
        raise ValueError("invalid bounded service-port mapping")
    return config


def unit_prelude(description, config):
    return f"[Unit]\nDescription={description}\nRequiresMountsFor={config['mount']}\nConditionPathIsMountPoint={config['mount']}\nAfter=network-online.target work-docker-network.service\nRequires=work-docker-network.service\n\n"


def network(config, vm_uid, proxy_uid):
    bridges = ", ".join(str(v) for v in config["ports"].values())
    local = ", ".join(str(ipaddress.IPv4Address(v)) for v in config["local_ips"])
    return f"""table inet work_docker {{
 set work_pod {{ type ipv4_addr; flags timeout; timeout 15s; }}
 set bridge_ports {{ type inet_service; elements = {{ {bridges} }}; }}
 set private4 {{ type ipv4_addr; flags interval; elements = {{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 }}; }}
 set local4 {{ type ipv4_addr; elements = {{ {local} }}; }}
 chain input {{ type filter hook input priority -10; policy accept;
   tcp dport {{ 2376, 2377 }} ip saddr @work_pod accept
   tcp dport {{ 2376, 2377 }} drop
 }}
 chain output {{ type filter hook output priority -10; policy accept;
   ip daddr 127.0.0.1 tcp dport @bridge_ports meta skuid != {proxy_uid} reject
   meta skuid {proxy_uid} jump proxy_out
   meta skuid {vm_uid} jump vm_out
 }}
 chain proxy_out {{
   ip daddr 127.0.0.1 tcp dport @bridge_ports ct state new,established ct mark set 0x5744 accept
   ip daddr @work_pod tcp sport 2377 ct direction reply ct state established accept
   reject
 }}
 chain vm_out {{
   ip daddr @work_pod tcp sport 2376 ct direction reply ct state established accept
   ip daddr 127.0.0.1 tcp sport @bridge_ports ct direction reply ct state established ct mark 0x5744 accept
   ip daddr @private4 reject
   ip daddr @local4 reject
   udp dport 53 accept
   tcp dport {{ 53, 80, 443 }} accept
   reject
 }}
}}
"""


def vm_unit(config):
    prefix = unit_prelude("Isolated work Docker KVM guest", config)
    binds = "".join(f"BindReadOnlyPaths={s['host']}:/run/work-dockervm/exports/{i}\n" for i, s in enumerate(config["sources"]))
    return prefix + f"""[Service]
Type=simple
User=work-dockervm
Group=work-dockervm
SupplementaryGroups=kvm
RuntimeDirectory=work-dockervm
RuntimeDirectoryMode=0700
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 {LIB}/runtime.py start {ROOT}/vm.json
ExecStop=/usr/bin/python3 {LIB}/runtime.py powerdown {ROOT}/vm.json
Restart=no
KillMode=control-group
TimeoutStopSec=25
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=no
PrivateMounts=yes
DevicePolicy=closed
DeviceAllow=/dev/kvm rw
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET
AppArmorProfile=work-dockervm
ReadWritePaths={config['mount']}/vm /run/work-dockervm
ReadOnlyPaths={config['mount']}/vm/base.qcow2 {config['mount']}/vm/seed.iso
{binds}MemoryMax=10G
MemorySwapMax=0
CPUQuota={config['cpus'] * 100}%
TasksMax=128
LimitNOFILE=4096
LimitCORE=0
IOReadBandwidthMax=/dev/disk/by-uuid/{config['uuid']} 120M
IOWriteBandwidthMax=/dev/disk/by-uuid/{config['uuid']} 60M
StandardOutput=append:{config['mount']}/vm/runtime.log
StandardError=append:{config['mount']}/vm/runtime.log

[Install]
WantedBy=multi-user.target
"""


def guest(config):
    files = []
    def add(path, content, permissions="0644"):
        files.append({"path": path, "permissions": permissions, "encoding": "b64", "content": base64.b64encode(content.encode()).decode()})
    for key, target in [("server_ca", "ca.pem"), ("server_cert", "cert.pem"), ("server_key", "key.pem")]:
        add("/etc/docker/tls/" + target, Path(config[key]).read_text(), "0600")
    daemon = {"hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"], "tls": True, "tlsverify": True, "tlscacert": "/etc/docker/tls/ca.pem", "tlscert": "/etc/docker/tls/cert.pem", "tlskey": "/etc/docker/tls/key.pem", "log-driver": "local", "log-opts": {"max-size": "10m", "max-file": "3"}}
    add("/etc/docker/daemon.json", json.dumps(daemon))
    add("/etc/systemd/system/docker.service", "[Unit]\nAfter=network-online.target containerd.service\nWants=network-online.target\nRequires=containerd.service\n[Service]\nType=notify\nExecStart=/usr/bin/dockerd --config-file=/etc/docker/daemon.json\nRestart=on-failure\nTimeoutStartSec=0\nDelegate=yes\nKillMode=process\n[Install]\nWantedBy=multi-user.target\n")
    fstab = "".join(f"source{i} {s['guest']} 9p trans=virtio,version=9p2000.L,cache=none,ro,nodev,nosuid,msize=1048576 0 0\n" for i, s in enumerate(config["sources"]))
    add("/etc/fstab.work-sources", fstab)
    setup = f"""#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gpg
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
printf '%s  %s\\n' '{config['docker_key_sha256']}' /etc/apt/keyrings/docker.asc | sha256sum -c -
printf '%s\\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce={config['docker_version']} docker-ce-cli={config['docker_version']} containerd.io
systemctl disable --now docker.socket || true
"""
    for s in config["sources"]:
        setup += "mkdir -p " + shlex.quote(s["guest"]) + "\n"
    setup += "cat /etc/fstab.work-sources >> /etc/fstab\nmodprobe 9pnet_virtio\nmount -a\nsystemctl daemon-reload\nsystemctl enable --now docker.service\n"
    add("/usr/local/sbin/setup-work-docker", setup, "0700")
    user = {"ssh_pwauth": False, "disable_root": True, "write_files": files, "runcmd": [["/usr/local/sbin/setup-work-docker"]]}
    # JSON is valid YAML; the header is required for cloud-init classification.
    return "#cloud-config\n" + json.dumps(user)


def write(path, content, mode=0o600, owner=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(mode)
    if owner:
        os.chown(path, 0, owner)


def install(config, source):
    checked(config)
    base = mount(config)
    # The guard unit's ReadWritePaths target must exist before its first
    # tick: systemd cannot set up that mount namespace for a missing
    # directory, so a fresh install fails the guard every 2 seconds.
    INHIBIT.parent.mkdir(parents=True, exist_ok=True)
    # Initial capacity covers maximum guest disk, existing cloud base/cache,
    # the work reserve and margin. Runtime hysteresis is a separate guard.
    if not (base / "vm/disk.qcow2").exists() and os.statvfs(base).f_bavail * os.statvfs(base).f_frsize < 60 * 2**30:
        raise RuntimeError("initial independent filesystem budget insufficient")
    cache = base / "image-cache"
    subprocess.run(["gpgv", "--keyring", "/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg", str(cache / "SHA256SUMS.gpg"), str(cache / "SHA256SUMS")], check=True)
    name = "noble-server-cloudimg-amd64.img"
    expected = next(line.split()[0] for line in (cache / "SHA256SUMS").read_text().splitlines() if line.split()[-1].lstrip("*") == name)
    digest = hashlib.sha256()
    with (cache / name).open("rb") as image:
        for block in iter(lambda: image.read(8 * 1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise RuntimeError("signed cloud-image content mismatch")
    if subprocess.run(["systemctl", "is-active", "--quiet", "work-dockervm.service"]).returncode == 0:
        raise RuntimeError("stop the guest before changing configuration")
    for user, groups in [("work-dockervm", "kvm"), ("work-docker-proxy", None)]:
        try: pwd.getpwnam(user)
        except KeyError:
            command = ["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin"]
            if groups: command += ["--groups", groups]
            subprocess.run(command + [user], check=True)
    vm_user, proxy_user = pwd.getpwnam("work-dockervm"), pwd.getpwnam("work-docker-proxy")
    allowed_groups = {vm_user.pw_gid, grp.getgrnam("kvm").gr_gid}
    if vm_user.pw_shell != "/usr/sbin/nologin" or set(os.getgrouplist(vm_user.pw_name, vm_user.pw_gid)) != allowed_groups:
        raise RuntimeError("existing VM account has unexpected login/groups")
    # The confined runtime stats every configured source before exporting
    # it. Grant the VM uid traversal (x, never read or listing) on
    # ancestors that deny it; the profile's per-source rules gate the rest.
    for source in config["sources"]:
        for parent in Path(source["host"]).parents:
            if parent == Path(config["mount"]):
                break
            if not parent.stat().st_mode & stat.S_IXOTH:
                subprocess.run(["setfacl", "-m", f"u:{vm_user.pw_uid}:x", str(parent)], check=True)
    authority = base / "authority"
    os.chown(authority, 0, proxy_user.pw_gid); authority.chmod(0o710)
    server_dir = authority / "server"
    os.chown(server_dir, 0, proxy_user.pw_gid); server_dir.chmod(0o750)
    for field in ["server_ca", "server_cert", "server_key"]:
        path = Path(config[field])
        if not path.resolve().is_relative_to(server_dir.resolve()):
            raise ValueError("server leaf path outside dedicated authority directory")
        os.chown(path, 0, proxy_user.pw_gid); path.chmod(0o440)
    vm = base / "vm"
    vm.mkdir(exist_ok=True, mode=0o700)
    os.chown(vm, vm_user.pw_uid, vm_user.pw_gid)
    if not (vm / "base.qcow2").exists():
        import shutil
        shutil.copyfile(cache / name, vm / "base.qcow2")
    ROOT.mkdir(exist_ok=True, mode=0o755)
    LIB.mkdir(parents=True, exist_ok=True, mode=0o755)
    write(LIB / "runtime.py", (source / "runtime.py").read_text(), 0o644)
    write(ROOT / "vm.json", json.dumps(config), 0o640, vm_user.pw_gid)
    write(ROOT / "watch.json", json.dumps(config))
    write(ROOT / "proxy.json", json.dumps(config), 0o640, proxy_user.pw_gid)
    write(ROOT / "nftables.conf", network(config, vm_user.pw_uid, proxy_user.pw_uid))
    units = Path("/etc/systemd/system")
    write(units / "work-dockervm.service", vm_unit(config))
    write(units / "work-docker-watch.service", unit_prelude("Fail-closed work pod source identity", config) + f"[Service]\nExecStart=/usr/bin/python3 {LIB}/runtime.py watch {ROOT}/watch.json\nRestart=always\nRestartSec=3\nNoNewPrivileges=yes\nCapabilityBoundingSet=CAP_NET_ADMIN\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nMemoryMax=128M\nTasksMax=32\n[Install]\nWantedBy=multi-user.target\n")
    write(units / "work-docker-proxy.service", unit_prelude("Authenticated fixed guest-service port relay", config) + f"[Service]\nUser=work-docker-proxy\nGroup=work-docker-proxy\nExecStart=/usr/bin/python3 {LIB}/runtime.py proxy {ROOT}/proxy.json\nRestart=on-failure\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadOnlyPaths={config['server_ca']} {config['server_cert']} {config['server_key']}\nMemoryMax=128M\nTasksMax=64\nRestrictAddressFamilies=AF_INET AF_UNIX\n[Install]\nWantedBy=multi-user.target\n")
    write(units / "work-docker-guard.service", f"[Unit]\nDescription=Stop and inhibit work VM on filesystem pressure\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 {LIB}/runtime.py guard {ROOT}/watch.json\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nReadWritePaths=/var/lib/work-docker-vm\n")
    write(units / "work-docker-guard.timer", "[Unit]\nDescription=Work VM filesystem pressure check\n[Timer]\nOnBootSec=5s\nOnUnitActiveSec=2s\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n")
    write(units / "work-docker-network.service", f"[Unit]\nDescription=Work VM dedicated nftables table\nBefore=work-dockervm.service work-docker-watch.service work-docker-proxy.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f {ROOT}/nftables.conf\nCapabilityBoundingSet=CAP_NET_ADMIN\nNoNewPrivileges=yes\n[Install]\nWantedBy=multi-user.target\n")
    # start() stats each source before execv; the profile needs a read rule
    # per source (and the library directory itself for import lookups).
    source_rules = "".join(f" {s['host']}/ r,\n {s['host']}/** r,\n" for s in config["sources"])
    profile = f"""#include <tunables/global>
profile work-dockervm flags=(attach_disconnected) {{
 #include <abstractions/base>
 /usr/bin/python3{{,.12}} ix,
 /usr/bin/findmnt ix,
 /usr/bin/qemu-system-x86_64 ix,
 /usr/lib/** mr,
 /usr/local/lib/work-docker-vm/** r,
 /usr/local/lib/work-docker-vm/ r,
 /usr/share/qemu/** r,
 /usr/share/seabios/** r,
 /usr/share/OVMF/** r,
 /etc/work-docker-vm/vm.json r,
 /etc/localtime r,
 /proc/** r,
 /sys/devices/system/** r,
 /sys/devices/virtual/** r,
 /dev/kvm rw,
 /dev/disk/by-uuid/* r,
 /run/udev/data/* r,
 /dev/null rw,
 /dev/urandom r,
 /run/work-dockervm/ r,
 /run/work-dockervm/qmp.sock rw,
 /run/work-dockervm/exports/ r,
 /run/work-dockervm/exports/** r,
 {config['mount']}/vm/ rw,
 {config['mount']}/vm/** rwk,
 /var/lib/work-docker-vm/ r,
 /var/lib/work-docker-vm/inhibited r,
{source_rules} network inet stream,
 network inet dgram,
 network unix stream,
 deny capability,
}}
"""
    write(Path("/etc/apparmor.d/work-dockervm"), profile)
    write(vm / "user-data", guest(config))
    write(vm / "meta-data", json.dumps({"instance-id": config["instance_id"], "local-hostname": "work-docker"}))
    net = {"version": 2, "ethernets": {"eth0": {"match": {"macaddress": "52:54:00:77:00:01"}, "set-name": "eth0", "addresses": ["10.0.2.15/24"], "routes": [{"to": "default", "via": "10.0.2.2"}], "nameservers": {"addresses": ["1.1.1.1", "9.9.9.9"]}}}}
    write(vm / "network-config", json.dumps(net))
    disk = vm / "disk.qcow2"
    if not disk.exists():
        subprocess.run(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(vm / "base.qcow2"), str(disk), "32G"], check=True)
        os.chown(disk, vm_user.pw_uid, vm_user.pw_gid)
    subprocess.run(["cloud-localds", "--network-config=" + str(vm / "network-config"), str(vm / "seed.iso"), str(vm / "user-data"), str(vm / "meta-data")], check=True)
    for path in [vm / "base.qcow2", vm / "seed.iso"]:
        os.chown(path, 0, vm_user.pw_gid); path.chmod(0o440)
    subprocess.run(["apparmor_parser", "-r", "/etc/apparmor.d/work-dockervm"], check=True)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    print("private configuration installed; start/verification remains explicit")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    install(json.loads(args.config.read_text()), Path(__file__).resolve().parent)
