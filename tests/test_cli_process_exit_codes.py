import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.storage import StorageManager
from agent_metrics.cli import CLIHandler


class TestCLIProcessExitCodes(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.python_exe = sys.executable
        self.env = os.environ.copy()
        self.env["PYTHONPATH"] = str(SRC_DIR)
        self.env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + self.env.get("PATH", "")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # 15.1 Exit 0: --help
    def test_module_exit_0_help(self):
        res = subprocess.run(
            [self.python_exe, "-m", "agent_metrics", "--help"],
            capture_output=True,
            text=True,
            env=self.env,
        )
        self.assertEqual(res.returncode, 0)

    # 15.2 Exit 2: reconcile when gh is missing from PATH
    def test_module_exit_2_reconcile_no_gh(self):
        storage = StorageManager(base_dir=self.temp_dir)
        run_id = storage.create_run({
            "started_at": "2026-08-01T10:00:00Z",
            "work_package": "WP-EXIT-2",
            "agent": {"shell": "bash", "provider": "Anthropic"}
        })
        
        # Strip gh from PATH
        no_gh_env = self.env.copy()
        paths = no_gh_env.get("PATH", "").split(os.pathsep)
        clean_paths = [p for p in paths if not (Path(p) / "gh").exists() and not (Path(p) / "gh.exe").exists()]
        no_gh_env["PATH"] = os.pathsep.join(clean_paths)

        cmd = [
            self.python_exe,
            "-c",
            f"import sys; sys.path.insert(0, {json.dumps(str(SRC_DIR))}); from agent_metrics.storage import StorageManager; from agent_metrics.cli import CLIHandler; raise SystemExit(CLIHandler(StorageManager({json.dumps(self.temp_dir)})).cmd_reconcile(run_id={json.dumps(run_id)}, pr_number=10))"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, env=no_gh_env)
        self.assertEqual(res.returncode, 2)

    # 15.3 Exit 4: finish bad id
    def test_module_exit_4_invalid_run_id(self):
        res = subprocess.run(
            [self.python_exe, "-m", "agent_metrics", "finish", "bad id"],
            capture_output=True,
            text=True,
            env=self.env,
        )
        self.assertEqual(res.returncode, 4)

    # 15.4 Exit 5: finish missing run_id
    def test_module_exit_5_missing_run_id(self):
        res = subprocess.run(
            [self.python_exe, "-m", "agent_metrics", "finish", "missing-run-id"],
            capture_output=True,
            text=True,
            env=self.env,
        )
        self.assertEqual(res.returncode, 5)

    # 15.5 Exit 6: show on tampered summary
    def test_module_exit_6_tampered_summary(self):
        storage = StorageManager(base_dir=self.temp_dir)
        cli = CLIHandler(storage_manager=storage)
        run_id = "66666666-6666-6666-6666-666666666666"
        storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        cli.cmd_finish(run_id=run_id, json_output=True)

        summary_file = Path(self.temp_dir, run_id, "sanitized-summary.json")
        data = json.loads(summary_file.read_text(encoding="utf-8"))
        data["work_package"] = "TAMPERED"
        summary_file.write_text(json.dumps(data), encoding="utf-8")

        cmd = [
            self.python_exe,
            "-c",
            f"import sys; sys.path.insert(0, {json.dumps(str(SRC_DIR))}); from agent_metrics.storage import StorageManager; from agent_metrics.cli import CLIHandler; raise SystemExit(CLIHandler(StorageManager({json.dumps(self.temp_dir)})).cmd_show(run_id={json.dumps(run_id)}))"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, env=self.env)
        self.assertEqual(res.returncode, 6)

    # 15.6 Exit 7: reconcile with fake gh failing
    def test_module_exit_7_fake_gh_error(self):
        storage = StorageManager(base_dir=self.temp_dir)
        run_id = storage.create_run({
            "started_at": "2026-08-01T10:00:00Z",
            "work_package": "WP-TEST-7",
            "repository": "Owner/Repo",
            "agent": {"shell": "bash", "provider": "Anthropic"}
        })

        py_code = (
            f"import sys; sys.path.insert(0, {json.dumps(str(SRC_DIR))}); "
            f"from unittest.mock import patch; "
            f"from agent_metrics.collectors.github_collector import GithubCollector; "
            f"patch.object(GithubCollector, 'collect_pr_info', return_value=(7, {{}})).start(); "
            f"from agent_metrics.storage import StorageManager; "
            f"from agent_metrics.cli import CLIHandler; "
            f"raise SystemExit(CLIHandler(StorageManager({json.dumps(self.temp_dir)})).cmd_reconcile(run_id={json.dumps(run_id)}, pr_number=42))"
        )
        cmd = [self.python_exe, "-c", py_code]
        res = subprocess.run(cmd, capture_output=True, text=True, env=self.env)
        self.assertEqual(res.returncode, 7)

    # 15.7 Doctor Exit Code Check
    def test_module_doctor_returns_exit_code(self):
        cmd = [
            self.python_exe,
            "-c",
            f"import sys; sys.path.insert(0, {json.dumps(str(SRC_DIR))}); from agent_metrics.cli import main; raise SystemExit(main(['doctor', '--json']))"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, env=self.env)
        self.assertIn(res.returncode, (0, 2))


if __name__ == "__main__":
    unittest.main()
