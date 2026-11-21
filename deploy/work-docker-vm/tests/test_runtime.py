#!/usr/bin/env python3
"""Offline safety fixtures; live VM/Docker/Compose acceptance is separate."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).parents[1]
sys.path.insert(0, str(DIRECTORY))
import runtime
SPEC = importlib.util.spec_from_file_location("installer", DIRECTORY / "install.py")
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def fixture():
    return {"mount": "/srv/fixture", "uuid": "00000000-0000-0000-0000-000000000001", "address": "192.168.1.2", "pod_cidr": "10.42.0.0/24", "node": "agent-1", "sources": [{"host": "/srv/fixture/work-t3code/data/repos/example", "guest": "/data/repos/example"}], "cpus": 4, "memory_mib": 8192, "disk_gib": 32, "start_gib": 35, "stop_gib": 25, "ports": {"18080": 40000}, "local_ips": ["127.0.0.1", "192.168.1.2"], "docker_version": "5:29.10.0-1~ubuntu.24.04~noble", "docker_key_sha256": "1" * 64}


class Safety(unittest.TestCase):
    def test_source_auth_root_and_alias_redirect_rejected(self):
        config = fixture()
        installer.checked(config)
        for guest in ["/data", "/data/agent-state", "/home/node/.t3", "/home/node/.t3/userdata", "/secrets"]:
            bad = copy.deepcopy(config); bad["sources"][0]["guest"] = guest
            with self.assertRaises(ValueError): installer.checked(bad)
        bad = copy.deepcopy(config); bad["sources"][0]["host"] = "/srv/fixture/authority/private"
        with self.assertRaisesRegex(ValueError, "mapping mismatch"): installer.checked(bad)

    def test_source_escape_ports_and_resource_bounds(self):
        config = fixture()
        for key, value in [("memory_mib", 65536), ("cpus", 16), ("disk_gib", 128), ("stop_gib", 1), ("start_gib", 1)]:
            bad = copy.deepcopy(config); bad[key] = value
            with self.assertRaises(ValueError): installer.checked(bad)
        for ports in [{"2376": 40000}, {"3773": 40000}, {"018080": 40000}, {"18080": 22}]:
            bad = copy.deepcopy(config); bad["ports"] = ports
            with self.assertRaises(ValueError): installer.checked(bad)

    def test_nft_has_expiry_private_denials_and_narrow_reply_paths(self):
        text = installer.network(fixture(), 900, 901)
        self.assertIn("timeout 15s", text)
        self.assertIn("meta skuid 900 jump vm_out", text)
        self.assertIn("meta skuid 901 jump proxy_out", text)
        self.assertIn("ip daddr @private4 reject", text)
        self.assertIn("ct direction reply ct state established", text)
        self.assertIn("ct mark 0x5744", text)
        self.assertNotIn("flush ruleset", text)
        self.assertNotIn("ct state established accept\n   ip daddr @private4", text)

    def test_vm_unit_kvm_privilege_budget_and_readonly_source(self):
        text = installer.vm_unit(fixture())
        for value in ["User=work-dockervm", "NoNewPrivileges=yes", "CapabilityBoundingSet=\n", "DevicePolicy=closed", "DeviceAllow=/dev/kvm rw", "PrivateDevices=no", "MemoryMax=10G", "MemorySwapMax=0", "CPUQuota=400%", "TasksMax=128", "Restart=no", "BindReadOnlyPaths=", "ConditionPathIsMountPoint=", "RequiresMountsFor="]:
            self.assertIn(value, text)
        self.assertNotIn("/var/run/docker.sock", text)

    def test_pod_identity_is_exact_ready_tokenless_and_local(self):
        config = fixture()
        pod = {"metadata": {"name": "work-t3code-0", "labels": {"app": "work-t3code"}}, "spec": {"nodeName": "agent-1", "automountServiceAccountToken": False}, "status": {"phase": "Running", "podIP": "10.42.0.7", "conditions": [{"type": "Ready", "status": "True"}]}}
        self.assertEqual(runtime.approved_pod(config, pod), "10.42.0.7")
        for path, value in [(('metadata', 'name'), "other-pod"), (('spec', 'hostNetwork'), True), (('spec', 'automountServiceAccountToken'), True), (('status', 'podIP'), "192.168.1.8")]:
            bad = copy.deepcopy(pod); bad[path[0]][path[1]] = value
            self.assertIsNone(runtime.approved_pod(config, bad))
        bad = copy.deepcopy(pod); bad['status']['conditions'] = []
        self.assertIsNone(runtime.approved_pod(config, bad))

    def test_guard_stops_whole_vm_and_requires_real_reset_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            inhibit = Path(directory) / "inhibited"
            with patch.object(runtime, "INHIBIT", inhibit), patch.object(runtime.subprocess, "run") as command:
                self.assertTrue(runtime.guard(fixture(), fixture=0))
                self.assertTrue(inhibit.exists())
                command.assert_called_once_with(["systemctl", "stop", "work-dockervm.service"], check=True)
                with patch.object(runtime, "available", return_value=34 * 2**30):
                    with self.assertRaises(RuntimeError): runtime.reset(fixture())
                self.assertTrue(inhibit.exists())
                with patch.object(runtime, "available", return_value=36 * 2**30): runtime.reset(fixture())
                self.assertFalse(inhibit.exists())

    def test_traversal_grants_only_denying_ancestors_not_the_mount(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory) / "m"
            source = mount / "a" / "b" / "repo"
            source.mkdir(parents=True)
            (mount / "a").chmod(0o700)
            config = {"mount": str(mount), "sources": [{"host": str(source)}]}
            with patch.object(installer.subprocess, "run") as command:
                granted = installer.grant_traversal(config, 999)
            self.assertEqual(granted, [str(mount / "a")])
            command.assert_called_once_with(["setfacl", "-m", "u:999:x", str(mount / "a")], check=True)

    def test_mount_missing_uuid_fails_closed(self):
        with patch.object(runtime.subprocess, "check_output", return_value="wrong\n"):
            with self.assertRaises(RuntimeError): runtime.mount(fixture())

    def test_refresh_atomic_expiring_set_only(self):
        with patch.object(runtime.subprocess, "run") as command:
            runtime.refresh(fixture(), "10.42.0.7")
            text = command.call_args.kwargs['input'].decode()
            self.assertEqual(text, "flush set inet work_docker work_pod\nadd element inet work_docker work_pod { 10.42.0.7 timeout 15s }\n")
            runtime.refresh(fixture(), None)
            self.assertEqual(command.call_args.kwargs['input'], b"flush set inet work_docker work_pod\n")


if __name__ == "__main__":
    unittest.main()
