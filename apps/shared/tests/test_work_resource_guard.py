"""Real POSIX subprocess/flock tests; all storage transitions are injected."""

from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
GUARD = Path(__file__).resolve().parents[1] / "work_resource_guard.py"
spec = importlib.util.spec_from_file_location("work_resource_guard", GUARD)
assert spec is not None and spec.loader is not None
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)


def alive(pid):
    if sys.platform.startswith("linux"):
        # Slim runtime images omit ps; procfs reports real zombie/liveness state.
        try:
            stat = Path("/proc/{}/stat".format(pid)).read_text()
            state = stat[stat.rfind(")") + 2:].split()[0]
            return state not in ("Z", "X")
        except (OSError, IndexError):
            return False
    try:
        value = subprocess.check_output(
            ["ps", "-o", "stat=", "-p", str(pid)], stderr=subprocess.DEVNULL,
        ).decode().strip()
        return bool(value) and not value.startswith("Z")
    except subprocess.CalledProcessError:
        return False


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="work-guard-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WORK_")}
        self.env.update({
            "WORK_RESOURCE_GUARD": "1", "WORK_RESOURCE_SCOPE": "work",
            "WORK_GUARD_PATH": str(self.root),
            "WORK_BUILD_LOCK": str(self.root / "build.lock"),
            "WORK_GUARD_START_GIB": "0.001", "WORK_GUARD_STOP_GIB": "0.0005",
            "WORK_GUARD_POLL_SECONDS": "0.03", "WORK_GUARD_GRACE_SECONDS": "0.15",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.config = guard.Config(str(self.root), str(self.root / "build.lock"), 100, 80, 0.03, 0.15)
        self.children = []
        self.addCleanup(self.cleanup_children)

    def cleanup_children(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()

    def script(self, name, text):
        path = self.root / name
        path.write_text(text)
        return str(path)

    def cli(self, command, mode="build", env=None):
        prefix = [sys.executable, str(GUARD), mode]
        if mode == "build":
            prefix += ["--tool", "npm"]
        return subprocess.run(prefix + ["--"] + command, env=self.env if env is None else env,
                              capture_output=True, text=True, timeout=8)

    def spawn(self, command, mode="build"):
        prefix = [sys.executable, str(GUARD), mode]
        if mode == "build":
            prefix += ["--tool", "npm"]
        child = subprocess.Popen(prefix + ["--"] + command, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def wait_file(self, path):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if path.exists():
                return
            time.sleep(0.02)
        self.fail("child did not create readiness fixture")

    def injected_child(self, command, expression, mode="supervise"):
        # Runs the real library in another process, injecting only the disk probe.
        code = (
            "import sys; sys.path.insert(0, {!r}); import work_resource_guard as g; "
            "from pathlib import Path; "
            "c=g.Config({!r}, {!r},100,80,0.03,0.15); "
            "probe={}; sys.exit(g.{}({!r},c,probe=probe))"
        ).format(str(GUARD.parent), str(self.root), self.config.lock_path, expression, mode, command)
        child = subprocess.Popen([sys.executable, "-c", code], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def stubborn_group(self):
        ready = self.root / "ready.json"
        script = self.script("stubborn.py", """
import json, os, signal, subprocess, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'])
Path(sys.argv[1]).write_text(json.dumps([os.getpid(), child.pid]))
while True: time.sleep(.02)
""")
        return [sys.executable, script, str(ready)], ready

    def assert_group_dead(self, ready):
        pids = json.loads(ready.read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and any(alive(pid) for pid in pids):
            time.sleep(.02)
        self.assertTrue(all(not alive(pid) for pid in pids), "process-group writer survived")

    def test_statvfs_uses_available_not_free_blocks(self):
        fake = lambda path: SimpleNamespace(f_bavail=7, f_bfree=999, f_frsize=4096)
        self.assertEqual(guard.available_bytes("unused", fake), 28672)

    def test_stat_error_and_invalid_stats_fail_closed(self):
        def broken(path):
            raise OSError("must not leak sensitive exception content")
        self.assertFalse(guard.has_space(self.config, 100, broken))
        fake = lambda path: SimpleNamespace(f_bavail=-1, f_frsize=4096)
        with self.assertRaises(OSError):
            guard.available_bytes("unused", fake)
        self.assertEqual(guard.serialized_build([sys.executable, "-c", "raise Exception('not launched')"],
                                                self.config, probe=broken), 75)

    def test_default_thresholds_and_configuration_validation(self):
        c = guard.Config.from_env({})
        self.assertEqual((c.start_bytes, c.stop_bytes, c.poll_seconds), (25 * guard.GIB, 20 * guard.GIB, 2))
        for values in ({"WORK_GUARD_POLL_SECONDS": "nan"}, {"WORK_GUARD_GRACE_SECONDS": "0"},
                       {"WORK_GUARD_START_GIB": "19"}, {"WORK_GUARD_STOP_GIB": "inf"}):
            with self.assertRaises(ValueError):
                guard.Config.from_env(values)

    def test_exact_argv_environment_and_exit_status(self):
        script = self.script("argv.py", "import json,os,sys; print(json.dumps([sys.argv[1:],os.environ.get('CARGO_BUILD_JOBS'),os.environ.get('NODE_OPTIONS')])); sys.exit(23)")
        args = ["space word", "quote'\"", "$(must-not-run)", "", "--flag=value"]
        env = dict(self.env, CARGO_BUILD_JOBS="7", NODE_OPTIONS="--trace-warnings --max-old-space-size=1024")
        result = self.cli([sys.executable, script] + args, env=env)
        self.assertEqual(result.returncode, 23)
        self.assertEqual(json.loads(result.stdout), [args, "7", env["NODE_OPTIONS"]])
        self.assertNotIn("must-not-run", result.stderr)

    def test_defaults_preserve_node_options(self):
        for options in ("--trace-warnings", '--require="space name.js"'):
            result = guard.build_environment({"NODE_OPTIONS": options})
            self.assertEqual(result["NODE_OPTIONS"], options + " --max-old-space-size=3072")
            self.assertEqual(result["CARGO_BUILD_JOBS"], "2")
        for options in ("--max_old_space_size 512", "--max-old-space-size=1024", '"bad'):
            self.assertEqual(guard.build_environment({"NODE_OPTIONS": options})["NODE_OPTIONS"], options)

    def test_disabled_or_personal_scope_executes_unmodified(self):
        script = self.script("env.py", "import json,os,sys; print(json.dumps([os.environ.get('CARGO_BUILD_JOBS'),os.environ.get('NODE_OPTIONS')])); sys.exit(19)")
        for setting in ({"WORK_RESOURCE_GUARD": "0"}, {"WORK_RESOURCE_SCOPE": "personal"}, {"WORK_RESOURCE_SCOPE": ""}):
            env = {k: v for k, v in self.env.items() if k not in ("NODE_OPTIONS", "CARGO_BUILD_JOBS")}
            env.update(setting)
            env["WORK_GUARD_PATH"] = "/does-not-exist"
            for mode in ("run", "build"):
                result = self.cli([sys.executable, script], mode=mode, env=env)
                self.assertEqual(result.returncode, 19)
                self.assertEqual(json.loads(result.stdout), [None, None])

    def test_readonly_commands_pass_even_invalid_guard_config(self):
        env = dict(self.env, WORK_GUARD_POLL_SECONDS="not a number")
        result = self.cli([sys.executable, "--version"], env=env)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("work-resource-guard", result.stderr)
        for tool in guard.TOOLS:
            self.assertTrue(guard.readonly_command(tool, ["--version"]))
            self.assertFalse(guard.readonly_command(tool, ["--version", "build"]))
            self.assertFalse(guard.readonly_command(tool, ["run", "--version"]))

    def test_invalid_active_config_fails_closed(self):
        result = self.cli([sys.executable, "-c", "print('should not run')"],
                          env=dict(self.env, WORK_GUARD_START_GIB="bad"))
        self.assertEqual(result.returncode, 75)
        self.assertEqual(result.stdout, "")

    def test_low_launch_refuses_build_without_data_deletion(self):
        data = self.root / "preserve-source.txt"
        data.write_text("dirty source")
        launched = self.root / "launched"
        status = guard.serialized_build([sys.executable, "-c", "from pathlib import Path; Path({!r}).touch()".format(str(launched))],
                                        self.config, probe=lambda path: 99)
        self.assertEqual(status, 75)
        self.assertFalse(launched.exists())
        self.assertEqual(data.read_text(), "dirty source")

    def test_lock_errors_fail_closed(self):
        config = replace(self.config, lock_path=str(self.root / "absent" / "lock"))
        self.assertEqual(guard.serialized_build([sys.executable, "-c", "pass"], config, probe=lambda path: 100), 75)

    def test_flock_serializes_independent_build_processes(self):
        events = self.root / "events"
        script = self.script("events.py", """
import os,sys,time
with open(sys.argv[1], 'a') as f: f.write('start:'+sys.argv[2]+'\\n'); f.flush()
time.sleep(.25)
with open(sys.argv[1], 'a') as f: f.write('end:'+sys.argv[2]+'\\n')
""")
        first = self.spawn([sys.executable, script, str(events), "a"])
        self.wait_file(events)
        second = self.spawn([sys.executable, script, str(events), "b"])
        self.assertEqual(first.wait(timeout=5), 0)
        self.assertEqual(second.wait(timeout=5), 0)
        self.assertEqual(events.read_text().splitlines(), ["start:a", "end:a", "start:b", "end:b"])

    def test_nested_build_reentrant_through_closed_fds(self):
        nested = [sys.executable, str(GUARD), "build", "--tool", "cargo", "--",
                  sys.executable, "-c", "print('nested'); raise SystemExit(17)"]
        code = "import subprocess,sys; sys.exit(subprocess.call({!r},close_fds=True))".format(nested)
        result = self.cli([sys.executable, "-c", code])
        self.assertEqual(result.returncode, 17)
        self.assertEqual(result.stdout.strip(), "nested")
        self.assertIn("shares ancestor", result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node is optional on the Mac test host")
    def test_nested_build_via_real_node_spawn(self):
        nested = [str(GUARD), "build", "--tool", "npm", "--", sys.executable, "-c", "print('node nested')"]
        code = "const c=require('child_process').spawnSync(%s,%s,{stdio:'inherit'});process.exit(c.status===null?99:c.status)" % (json.dumps(sys.executable), json.dumps(nested))
        result = self.cli([shutil.which("node"), "-e", code])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node nested", result.stdout)

    def test_stale_or_forged_owner_does_not_skip_lock(self):
        fd = os.open(self.config.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.write(fd, json.dumps({"pid": os.getpid(), "token": "stale"}).encode())
            self.assertFalse(guard.inherited_lock({guard.LOCK_OWNER_ENV: "other"}, fd))
            self.assertFalse(guard.inherited_lock({guard.LOCK_OWNER_ENV: "stale"}, fd))
        finally:
            os.close(fd)

    def test_inaccessible_nested_ancestry_fails_instead_of_deadlocking(self):
        Path(self.config.lock_path).write_text(json.dumps({"pid": 1234567, "token": "owner"}))
        env = dict(self.env, WORK_BUILD_LOCK_OWNER="owner")
        with patch.object(guard, "parent_pid", return_value=None):
            status = guard.serialized_build([sys.executable, "-c", "print('must not run')"],
                                            self.config, env=env, probe=lambda path: 100)
        self.assertEqual(status, 75)

    def test_build_low_transition_kills_stubborn_entire_group(self):
        command, ready = self.stubborn_group()
        expression = "lambda path: 0 if Path({!r}).exists() else 100".format(str(ready))
        child = self.injected_child(command, expression, mode="serialized_build")
        self.assertEqual(child.wait(timeout=5), 75)
        self.assert_group_dead(ready)
        # The shared slot is released after the group is stopped.
        self.assertEqual(self.cli([sys.executable, "-c", "pass"]).returncode, 0)

    def test_stat_error_during_build_stops_group(self):
        command, ready = self.stubborn_group()
        expression = "lambda path: (_ for _ in ()).throw(OSError()) if Path({!r}).exists() else 100".format(str(ready))
        child = self.injected_child(command, expression, mode="serialized_build")
        self.assertEqual(child.wait(timeout=5), 75)
        self.assert_group_dead(ready)

    def test_external_term_kills_group_and_returns_signal_status(self):
        command, ready = self.stubborn_group()
        child = self.spawn(command, mode="run")
        self.wait_file(ready)
        child.terminate()
        self.assertEqual(child.wait(timeout=5), 143)
        self.assert_group_dead(ready)

    def test_signal_exit_status_is_preserved(self):
        result = self.cli([sys.executable, "-c", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)"])
        self.assertEqual(result.returncode, 143)

    def test_supervisor_waits_for_launch_then_exits_on_pressure(self):
        launches = self.root / "launches"
        recovery = self.root / "recovery"
        script = self.script("server.py", """
import sys,time
from pathlib import Path
p=Path(sys.argv[1])
p.write_text('1')
while True: time.sleep(.02)
""")
        expression = "lambda path: (100 if Path({0!r}).exists() else 90) if not Path({1!r}).exists() else 0".format(str(recovery), str(launches))
        child = self.injected_child([sys.executable, script, str(launches)], expression)
        time.sleep(.2)
        self.assertFalse(launches.exists())
        recovery.touch()
        self.wait_file(launches)
        self.assertEqual(child.wait(timeout=5), 75)
        self.assertEqual(launches.read_text(), "1")

    def test_supervisor_preserves_coordinated_state_saver_shutdown(self):
        ready = self.root / "leader-ready"
        saver_ready = self.root / "saver-ready"
        stop = self.root / "stop-saver"
        saved = self.root / "saved-state"
        interrupted = self.root / "interrupted-saver"
        saver = self.script("saver.py", """
import signal,sys,time
from pathlib import Path
ready,stop,saved,bad=map(Path,sys.argv[1:])
def on_term(sig,frame):
    bad.touch()
    sys.exit(1)
signal.signal(signal.SIGTERM,on_term)
ready.touch()
while not stop.exists(): time.sleep(.005)
saved.write_text('complete')
""")
        leader = self.script("leader.py", """
import signal,subprocess,sys,time
from pathlib import Path
p=subprocess.Popen([sys.executable]+sys.argv[1:6])
while not Path(sys.argv[2]).exists(): time.sleep(.005)
def on_term(sig,frame):
    Path(sys.argv[3]).touch()
    p.wait(timeout=1)
    sys.exit(0)
signal.signal(signal.SIGTERM,on_term)
Path(sys.argv[6]).touch()
while True: time.sleep(.01)
""")
        command = [sys.executable, leader, saver, str(saver_ready), str(stop), str(saved), str(interrupted), str(ready)]
        child = self.injected_child(command, "lambda path: 100")
        self.wait_file(ready)
        child.terminate()
        self.assertEqual(child.wait(timeout=5), 143)
        self.assertEqual(saved.read_text(), "complete")
        self.assertFalse(interrupted.exists())

    def test_startup_stat_failure_waits_without_launch_and_is_interruptible(self):
        marker = self.root / "launched"
        command = [sys.executable, "-c", "from pathlib import Path; Path({!r}).touch()".format(str(marker))]
        child = self.injected_child(command, "lambda path: (_ for _ in ()).throw(OSError())")
        time.sleep(.2)
        self.assertFalse(marker.exists())
        child.terminate()
        self.assertEqual(child.wait(timeout=5), 143)

    def test_linux_procfs_parsing_and_descendant_groups(self):
        proc = self.root / "proc"
        proc.mkdir()
        for pid, parent, group in ((100, 1, 100), (101, 100, 101), (102, 101, 101), (300, 1, 300)):
            entry = proc / str(pid)
            entry.mkdir()
            (entry / "stat").write_text("{} (name with ) parentheses) S {} {} 0 0".format(pid, parent, group))
        real_path = Path
        def mapped_path(value):
            return proc / value[len("/proc/"):] if value.startswith("/proc/") else proc
        with patch.object(guard.sys, "platform", "linux"), patch.object(guard, "Path", side_effect=mapped_path):
            self.assertEqual(guard.parent_pid(102), 101)
            self.assertEqual(guard.descendant_groups(100), {100, 101})
        self.assertTrue(real_path(self.root).exists())

    def test_missing_executable_returns_127(self):
        self.assertEqual(self.cli([str(self.root / "no-executable")]).returncode, 127)
        nested = [sys.executable, str(GUARD), "build", "--tool", "cargo", "--", str(self.root / "no-executable")]
        result = self.cli([sys.executable, "-c", "import subprocess,sys; sys.exit(subprocess.call({!r}))".format(nested)])
        self.assertEqual(result.returncode, 127)

    def test_threshold_boundaries_allow_exact_watermarks(self):
        self.assertTrue(guard.has_space(self.config, 100, lambda path: 100))
        self.assertFalse(guard.has_space(self.config, 100, lambda path: 99))
        self.assertTrue(guard.has_space(self.config, 80, lambda path: 80))

    def test_readonly_queries_do_not_acquire_lock_or_modify_env(self):
        script = self.script("query", "#!" + sys.executable + "\nimport json,os,sys; print(json.dumps([sys.argv[1:], os.environ.get('CARGO_BUILD_JOBS')])); sys.exit(13)\n")
        os.chmod(script, 0o700)
        env = {k: v for k, v in self.env.items() if k != "CARGO_BUILD_JOBS"}
        env["WORK_GUARD_PATH"] = "/does-not-exist"
        result = self.cli([script, "view", "package-name", "--json"], env=env)
        self.assertEqual(result.returncode, 13)
        self.assertEqual(json.loads(result.stdout), [["view", "package-name", "--json"], None])
        self.assertFalse(Path(self.config.lock_path).exists())
        for tool, args in (("cargo", ["metadata", "--no-deps"]), ("docker", ["inspect", "container"]),
                           ("bun", ["pm", "ls"]), ("pnpm", ["config", "get", "registry"])):
            self.assertTrue(guard.readonly_command(tool, args))
        self.assertFalse(guard.readonly_command("make", ["-n"]))
        self.assertFalse(guard.readonly_command("docker", ["buildx", "inspect", "--bootstrap"]))

    def test_supervisor_stops_nested_build_session_before_wrapper_dies(self):
        command, ready = self.stubborn_group()
        nested = [sys.executable, str(GUARD), "build", "--tool", "npm", "--"] + command
        server_code = "import subprocess,sys; sys.exit(subprocess.call({!r}))".format(nested)
        child = self.injected_child([sys.executable, "-c", server_code],
                                    "lambda path: 0 if Path({!r}).exists() else 100".format(str(ready)))
        self.wait_file(ready)
        time.sleep(.4)
        self.assert_group_dead(ready)
        self.assertEqual(child.wait(timeout=5), 75)

    def test_leader_exit_does_not_leave_same_group_background_writer(self):
        ready = self.root / "background"
        code = "import subprocess,sys; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)']); Path({!r}).write_text(str(p.pid)); sys.exit(21)".format(str(ready))
        result = self.cli([sys.executable, "-c", code])
        self.assertEqual(result.returncode, 21)
        self.assertFalse(alive(int(ready.read_text())))

    def test_waiting_build_handles_signal_and_low_space(self):
        ready = self.root / "ready"
        holder = self.spawn([sys.executable, "-c", "from pathlib import Path; import time; Path({!r}).touch(); time.sleep(3)".format(str(ready))])
        self.wait_file(ready)
        waiting = self.spawn([sys.executable, "-c", "print('never')"])
        time.sleep(.15)
        waiting.terminate()
        self.assertEqual(waiting.wait(timeout=3), 143)
        low = self.root / "queue-low"
        expression = "lambda path: 0 if Path({!r}).exists() else 100".format(str(low))
        refused = self.injected_child([sys.executable, "-c", "print('never')"], expression, mode="serialized_build")
        time.sleep(.15)
        self.assertIsNone(refused.poll())
        low.touch()
        self.assertEqual(refused.wait(timeout=3), 75)
        holder.terminate()
        self.assertEqual(holder.wait(timeout=3), 143)


if __name__ == "__main__":
    unittest.main()
