import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from install_work_build_shims import install


class ShimInstallationTests(unittest.TestCase):
    def test_disabled_scope_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "guard"
            result = install(root, {"WORK_RESOURCE_GUARD": "1", "WORK_RESOURCE_SCOPE": "personal"}, "/unused")
            self.assertEqual(result, {})
            self.assertFalse(root.exists())

    def test_real_installation_and_shim_preserve_argv_and_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            real = base / "real tools"
            real.mkdir()
            executable = real / "npm"
            text = "#!" + sys.executable + "\nimport json,sys; print(json.dumps(sys.argv[1:])); sys.exit(23)\n"
            executable.write_text(text)
            executable.chmod(0o700)
            shim = Path(__file__).resolve().parents[1] / "work-build-shim.py"
            root = base / "guard"
            env = dict(os.environ, WORK_RESOURCE_GUARD="1", WORK_RESOURCE_SCOPE="work")
            env["PATH"] = str(real) + os.pathsep + env.get("PATH", os.defpath)
            mapping = install(root, env, str(shim))
            self.assertEqual(mapping["npm"], str(executable))
            self.assertEqual(executable.read_text(), text)
            self.assertTrue((root / "bin" / "npm").is_symlink())
            self.assertEqual(json.loads((root / "commands.json").read_text())["npm"], str(executable))
            env.update(WORK_GUARD_COMMAND_MAP=str(root / "commands.json"), WORK_GUARD_PATH=str(base),
                       WORK_BUILD_LOCK=str(base / "build.lock"), WORK_GUARD_START_GIB="0.000001",
                       WORK_GUARD_STOP_GIB="0.0000005", WORK_GUARD_POLL_SECONDS="0.01")
            args = ["run", "build", "space word", "quote'\"", "$(do-not-run)", ""]
            result = subprocess.run([sys.executable, str(root / "bin" / "npm"), *args], env=env,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 23)
            self.assertEqual(json.loads(result.stdout), args)
            self.assertNotIn("do-not-run", result.stderr)

    def profile_path(self, scope, directory, initial):
        hook = Path(__file__).resolve().parents[1] / "work-resource-guard-profile.sh"
        env = dict(os.environ, WORK_RESOURCE_GUARD="1", WORK_RESOURCE_SCOPE=scope,
                   WORK_GUARD_SHIM_BIN=str(directory), PATH=initial)
        script = '. "$1"; first="$PATH"; . "$1"; [ "$first" = "$PATH" ] || exit 1; printf "%s" "$PATH"'
        result = subprocess.run(["/bin/sh", "-c", script, "profile-test", str(hook)],
                                env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_login_profile_restores_work_shims_before_system_bins(self):
        with tempfile.TemporaryDirectory() as directory:
            initial = "/usr/local/bin:/usr/bin:" + directory
            self.assertEqual(self.profile_path("work", directory, initial), directory + ":" + initial)

    def test_login_profile_leaves_personal_path_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.profile_path("personal", directory, "/usr/local/bin:/usr/bin"),
                             "/usr/local/bin:/usr/bin")

    def test_login_profile_requires_installed_shims(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / "absent")
            self.assertEqual(self.profile_path("work", missing, "/usr/local/bin:/usr/bin"),
                             "/usr/local/bin:/usr/bin")

    def test_refuses_symlinked_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            link = base / "guard"
            link.symlink_to(base, target_is_directory=True)
            with self.assertRaises(ValueError):
                install(link, {"WORK_RESOURCE_GUARD": "1", "WORK_RESOURCE_SCOPE": "work"}, "/unused")


if __name__ == "__main__":
    unittest.main()
