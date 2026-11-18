"""Offline safety contract; the maintenance run additionally exercises rsync."""
import importlib.util
from pathlib import Path
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("migration", Path(__file__).parents[1] / "migrate-storage.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StorageSafety(unittest.TestCase):
    def test_missing_mount_fails_closed(self):
        with patch.object(MODULE.subprocess, "check_output", return_value="other\n"):
            with self.assertRaisesRegex(RuntimeError, "not mounted"):
                MODULE.mounted({"mount": "/", "uuid": "expected"})

    def test_root_fallback_fails_closed(self):
        with patch.object(MODULE.subprocess, "check_output", return_value="expected\n"):
            with self.assertRaisesRegex(RuntimeError, "root filesystem"):
                MODULE.mounted({"mount": "/", "uuid": "expected"})

    def test_path_escape_and_symlink_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            mount = root / "ssd"
            source = root / "source"
            outside = root / "outside"
            for path in (mount, source, outside):
                path.mkdir()
            config = {"volumes": [{"source": str(source), "destination": str(outside)}, {"source": str(source), "destination": str(mount / "state")}]}
            with patch.object(MODULE, "mounted", return_value=mount.resolve()):
                with self.assertRaisesRegex(RuntimeError, "escapes"):
                    MODULE.validate(config)
                (mount / "redirect").symlink_to(outside, target_is_directory=True)
                config["volumes"][0]["destination"] = str(mount / "redirect" / "data")
                with self.assertRaisesRegex(RuntimeError, "escapes"):
                    MODULE.validate(config)
                config["volumes"][0]["source"] = str(mount)
                with self.assertRaisesRegex(RuntimeError, "original filesystem"):
                    MODULE.validate(config)

    def test_surviving_rw_mount_blocks_final_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            process = root / "proc" / "123"
            process.mkdir(parents=True)
            source = root / "old"
            source.mkdir()
            (process / "fd").mkdir()
            (process / "mountinfo").write_text(f"1 2 8:1 {source} /data rw - ext4 /dev/a rw\n")
            config = {"volumes": [{"source": str(source)}]}
            with self.assertRaisesRegex(RuntimeError, "mounted writable"):
                MODULE.no_writers(config, root / "proc")
            (process / "mountinfo").write_text(f"1 2 8:1 {source} /data ro - ext4 /dev/a rw\n")
            MODULE.no_writers(config, root / "proc")

    def test_writable_descriptor_blocks_final_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            process = root / "proc" / "123"
            (process / "fd").mkdir(parents=True)
            (process / "fdinfo").mkdir()
            source = root / "old"
            source.mkdir()
            (process / "mountinfo").write_text("")
            (process / "fd" / "9").symlink_to(source / "file")
            (process / "fdinfo" / "9").write_text("flags:\t0100002\n")
            with self.assertRaisesRegex(RuntimeError, "writable descriptor"):
                MODULE.no_writers({"volumes": [{"source": str(source)}]}, root / "proc")

    def test_overlapping_destinations_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            mount = root / "ssd"
            source = root / "source"
            mount.mkdir()
            source.mkdir()
            config = {"volumes": [{"source": str(source), "destination": str(mount / "data")}, {"source": str(source), "destination": str(mount / "data" / "state")}]}
            with patch.object(MODULE, "mounted", return_value=mount.resolve()):
                with self.assertRaisesRegex(RuntimeError, "overlapping"):
                    MODULE.validate(config)

    @unittest.skipUnless(sys.platform == "linux" and shutil.which("rsync"), "requires Linux rsync ACL/xattr support")
    def test_real_copy_checksum_hardlinks_xattrs_and_retained_delta(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            mount = root / "ssd"
            mount.mkdir()
            volumes = []
            for name in ("data", "state"):
                source = root / ("old-" + name)
                source.mkdir()
                (source / "precious").write_bytes(b"ignored but precious\n")
                (source / "precious").chmod(0o640)
                os.setxattr(source / "precious", "user.fixture", b"preserve")
                os.link(source / "precious", source / "hardlink")
                (source / "symlink").symlink_to("precious")
                if shutil.which("setfacl"):
                    subprocess.run(["setfacl", "-m", "u:12345:r--", str(source / "precious")], check=True)
                volumes.append({"source": str(source), "destination": str(mount / name)})
            config = {"uuid": "fixture", "volumes": volumes}
            audit = mount / "audit"
            with patch.object(MODULE, "mounted", return_value=mount), patch.object(MODULE, "no_writers"):
                MODULE.run(config, "precopy", audit)
                (mount / "data" / "stale").write_bytes(b"keep rollback")
                MODULE.run(config, "final", audit)
                MODULE.run(config, "verify", audit)
                for volume in volumes:
                    a, b = Path(volume["source"]), Path(volume["destination"])
                    self.assertEqual((a / "precious").read_bytes(), (b / "precious").read_bytes())
                    self.assertEqual(stat.S_IMODE((a / "precious").stat().st_mode), stat.S_IMODE((b / "precious").stat().st_mode))
                    self.assertEqual((b / "precious").stat().st_ino, (b / "hardlink").stat().st_ino)
                    self.assertEqual(os.readlink(b / "symlink"), "precious")
                    self.assertEqual(os.getxattr(b / "precious", "user.fixture"), b"preserve")
                self.assertEqual((audit / "retained-precopy-0" / "stale").read_bytes(), b"keep rollback")
                (mount / "data" / "precious").write_bytes(b"corrupt")
                with self.assertRaisesRegex(RuntimeError, "unexplained differences"):
                    MODULE.run(config, "verify", audit)

    def test_checksum_difference_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            destination = root / "destination"
            destination.mkdir()
            config = {"uuid": "expected", "volumes": [{"source": str(root / "source"), "destination": str(destination)}]}
            def fake_rsync(args, **kwargs):
                self.assertIn("--checksum", args)
                self.assertIn("--dry-run", args)
                kwargs["stdout"].write(b">f+++++++++ missing\n")
                return type("Result", (), {"returncode": 0})()
            with patch.object(MODULE, "validate"), patch.object(MODULE, "mounted"), patch.object(MODULE, "no_writers"), patch.object(MODULE.subprocess, "run", side_effect=fake_rsync):
                with self.assertRaisesRegex(RuntimeError, "unexplained differences"):
                    MODULE.run(config, "verify", root / "audit")
                self.assertFalse((root / "audit" / "verify.json").exists())


if __name__ == "__main__":
    unittest.main()
