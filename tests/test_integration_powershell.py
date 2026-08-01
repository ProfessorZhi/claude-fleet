"""
Integration tests for PowerShell launcher agent-metrics.ps1 (Phase 3.4).
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path


class TestIntegrationPowerShell(unittest.TestCase):
    def setUp(self):
        self.project_root = Path(__file__).resolve().parent.parent
        self.ps1_script = self.project_root / "agent-metrics.ps1"

    def test_powershell_doctor_json(self):
        if shutil.which("powershell") is None:
            self.skipTest("PowerShell is not available on this system.")

        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.ps1_script),
            "doctor",
            "--json",
        ]
        res = subprocess.run(
            cmd,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            timeout=15,
        )

        self.assertIn(res.returncode, (0, 2))
        data = json.loads(res.stdout)
        self.assertIn("version", data)
        self.assertIn("python_version", data)

    def test_powershell_exit_code_passthrough(self):
        if shutil.which("powershell") is None:
            self.skipTest("PowerShell is not available on this system.")

        # Pass non-existent command to trigger non-zero exit code
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.ps1_script),
            "non-existent-subcommand",
        ]
        res = subprocess.run(
            cmd,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
        self.assertIn(res.returncode, (2, 4))


if __name__ == "__main__":
    unittest.main()
