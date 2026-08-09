"""
Integration tests for PowerShell launcher agent-metrics.ps1 (Phase 3.4 & V0.2 Closure).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
from agent_metrics.storage import StorageManager


class TestIntegrationPowerShell(unittest.TestCase):
    def setUp(self):
        self.project_root = Path(__file__).resolve().parent.parent
        self.ps1_script = self.project_root / "agent-metrics.ps1"
        self.temp_dir = tempfile.mkdtemp()
        self.env = os.environ.copy()
        self.env["PYTHONPATH"] = str(SRC_DIR)
        self.env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + self.env.get("PATH", "")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _powershell_cmd(self, args, env=None):
        if shutil.which("powershell") is None:
            self.skipTest("PowerShell is not available on this system.")
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.ps1_script),
        ] + args
        return subprocess.run(
            cmd,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env or self.env,
            timeout=15,
        )

    def test_powershell_help_exit_0(self):
        res = self._powershell_cmd(["--help"])
        self.assertEqual(res.returncode, 0)

    def test_powershell_doctor_json_exit(self):
        res = self._powershell_cmd(["doctor", "--json"])
        self.assertIn(res.returncode, (0, 2))
        data = json.loads(res.stdout)
        self.assertIn("version", data)
        self.assertIn("python_version", data)

    def test_powershell_finish_bad_id_exit_4(self):
        res = self._powershell_cmd(["finish", "bad id"])
        self.assertEqual(res.returncode, 4)

    def test_powershell_reconcile_no_gh_exit_2(self):
        storage = StorageManager()
        run_id = storage.create_run({
            "started_at": "2026-08-01T10:00:00Z",
            "work_package": "WP-PS1-RECONCILE",
            "agent": {"shell": "bash", "provider": "Anthropic"}
        })

        no_gh_env = self.env.copy()
        paths = no_gh_env.get("PATH", "").split(os.pathsep)
        clean_paths = [p for p in paths if not (Path(p) / "gh").exists() and not (Path(p) / "gh.exe").exists()]
        no_gh_env["PATH"] = os.pathsep.join(clean_paths)

        res = self._powershell_cmd(["reconcile", run_id], env=no_gh_env)
        self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main()
