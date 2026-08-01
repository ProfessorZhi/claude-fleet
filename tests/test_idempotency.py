"""
Unit tests for finish idempotency.
"""

import tempfile
import shutil
import unittest
from pathlib import Path

from agent_metrics.storage import StorageManager
from agent_metrics.cli import CLIHandler


class TestFinishIdempotency(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_finish_idempotency_byte_exact(self):
        run_id = "33333333-4444-5555-6666-777777777777"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})

        # 1. First finish
        self.cli.cmd_finish(run_id=run_id)
        run_dir = self.storage.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        bytes_first = summary_file.read_bytes()
        events_first = self.storage.read_events(run_id)

        # 2. Second finish without --refresh
        self.cli.cmd_finish(run_id=run_id)
        bytes_second = summary_file.read_bytes()
        events_second = self.storage.read_events(run_id)

        # Bytes and event count must be 100% identical
        self.assertEqual(bytes_first, bytes_second)
        self.assertEqual(len(events_first), len(events_second))


if __name__ == "__main__":
    unittest.main()
