"""
Fault tolerance and corruption unit tests (Phase 4.1 & 4.2).
"""

import json
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
from agent_metrics.models import EXIT_STORAGE_ERROR, EXIT_INVALID_INPUT


class TestFaults(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # Corrupted / Truncated run-context.json
    def test_truncated_run_context(self):
        run_dir = Path(self.temp_dir, "bad-run-id")
        run_dir.mkdir(parents=True, exist_ok=True)
        ctx_file = run_dir / "run-context.json"
        ctx_file.write_text('{"schema_version": 1, "run_id": "bad-run-id"', encoding="utf-8")  # Truncated

        code = self.cli.cmd_finish(run_id="bad-run-id", json_output=False)
        self.assertEqual(code, EXIT_STORAGE_ERROR)

    # Incomplete events.jsonl last line
    def test_incomplete_events_jsonl(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "bad-events-id",
            "work_package": "WP-FAULT",
            "started_at": "2026-08-01T10:00:00Z",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)

        # Append corrupt incomplete line
        events_file = Path(self.temp_dir, "bad-events-id", "events.jsonl")
        with open(events_file, "a", encoding="utf-8") as f:
            f.write('{"event_id": "123", "event_type": "INCOMPLETE')

        # Finish should still complete cleanly without crashing
        code = self.cli.cmd_finish(run_id="bad-events-id")
        self.assertEqual(code, 0)

    # Corrupted SHA file / missing SHA file
    def test_missing_sha_file(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "no-sha-id",
            "work_package": "WP-FAULT",
            "started_at": "2026-08-01T10:00:00Z",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)
        self.cli.cmd_finish(run_id="no-sha-id")

        # Delete sha file
        sha_file = Path(self.temp_dir, "no-sha-id", "sanitized-summary.sha256")
        if sha_file.exists():
            sha_file.unlink()

        sha_val = self.storage.read_sanitized_summary_sha256("no-sha-id")
        self.assertIsNone(sha_val)

    # Finished_at earlier than started_at (System Clock Skew)
    def test_time_anomaly_clock_backward(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "time-anomaly-id",
            "work_package": "WP-FAULT",
            "started_at": "2026-08-01T10:30:00+00:00",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)

        with patch("agent_metrics.cli.get_utc_now_iso", return_value="2026-08-01T10:10:00+00:00"):
            self.cli.cmd_finish(run_id="time-anomaly-id")

        summary = self.storage.read_sanitized_summary("time-anomaly-id")
        self.assertEqual(summary["timing"]["wall_clock_seconds"], 0.0)


if __name__ == "__main__":
    unittest.main()
