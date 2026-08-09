"""
Recovery and interruption handling tests (Phase 4.1 recovery).
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.storage import StorageManager
from agent_metrics.cli import CLIHandler


class TestRecovery(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_recovery_from_incomplete_run(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "interrupted-run-id",
            "work_package": "RECOVERY-WP",
            "started_at": "2026-08-01T10:00:00Z",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)

        # Simulate crash before finish: leftover temp file
        tmp_file = Path(self.temp_dir, "interrupted-run-id", ".sanitized-summary.json.tmp_9999")
        tmp_file.write_text("partial data", encoding="utf-8")

        # Call finish now - should recover cleanly and produce final summary
        code = self.cli.cmd_finish(run_id="interrupted-run-id")
        self.assertEqual(code, 0)

        summary = self.storage.read_sanitized_summary("interrupted-run-id")
        self.assertEqual(summary["work_package"], "RECOVERY-WP")


if __name__ == "__main__":
    unittest.main()
