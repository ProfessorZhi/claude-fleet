"""
Integration tests for complete run lifecycle.
"""

import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.cli import CLIHandler
from agent_metrics.storage import StorageManager
from agent_metrics.models import EXIT_OK


def extract_run_id(output: str) -> str:
    m = re.search(r"^RUN_ID=([a-f0-9\-]+)$", output, re.MULTILINE | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m2 = re.search(r'ZUNO_AGENT_RUN_ID="([a-f0-9\-]+)"', output, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    if "{" in output:
        try:
            s_idx = output.find("{")
            e_idx = output.rfind("}") + 1
            data = json.loads(output[s_idx:e_idx])
            return str(data.get("run_id", "")).strip('"\' \n\r')
        except Exception:
            pass
    return ""


class TestIntegrationWorkflow(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_full_lifecycle(self):
        # 1. start
        with patch("sys.stdout", new=io.StringIO()) as start_out:
            code = self.cli.cmd_start(
                agent_shell="Claude-Code",
                provider="DeepSeek",
                configured_model="deepseek-v4-flash",
                work_package="INT-WP-01",
                pr_number=56,
                json_output=True,
            )
            self.assertEqual(code, EXIT_OK)
            run_id = extract_run_id(start_out.getvalue())

        # Verify run-context.json exists
        ctx = self.storage.read_run_context(run_id)
        original_started_at = ctx["started_at"]

        # 2. finish
        with patch("sys.stdout", new=io.StringIO()) as finish_out:
            code = self.cli.cmd_finish(run_id=run_id, json_output=True)
            self.assertEqual(code, EXIT_OK)
            summary = json.loads(finish_out.getvalue())

        # Verify timing
        self.assertEqual(summary["timing"]["started_at"], original_started_at)
        self.assertIsNotNone(summary["timing"]["finished_at"])
        self.assertGreaterEqual(summary["timing"]["wall_clock_seconds"], 0.0)
        self.assertIsNone(summary["timing"]["agent_active_seconds"])

        # Verify SHA-256
        sha_val = summary["integrity"]["payload_sha256"]
        self.assertEqual(len(sha_val), 64)

        # 3. export
        export_file = Path(self.temp_dir, "summary_exported.json")
        code = self.cli.cmd_export(run_id=run_id, format_name="json", output_path=str(export_file))
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(export_file.exists())

        # 4. Idempotent finish check
        with patch("sys.stdout", new=io.StringIO()) as finish2_out:
            code2 = self.cli.cmd_finish(run_id=run_id, json_output=True)
            self.assertEqual(code2, EXIT_OK)
            summary2 = json.loads(finish2_out.getvalue())
            self.assertEqual(summary2["timing"]["started_at"], original_started_at)


if __name__ == "__main__":
    unittest.main()
