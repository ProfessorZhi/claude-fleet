import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.storage import StorageManager
from agent_metrics.cli import CLIHandler


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


class TestStorageAndTiming(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # Test 11: UTC ISO format timestamp validation
    def test_utc_iso_format(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        ctx = self.storage.read_run_context(run_id)
        started_at = ctx["started_at"]
        dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        self.assertEqual(dt.tzinfo, timezone.utc)

    # Test 12: Wall clock calculation correctness
    def test_wall_clock_calculation(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "test-wall-clock-uuid",
            "work_package": "WP-TIMING",
            "started_at": "2026-08-01T10:00:00+00:00",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)

        with patch("agent_metrics.cli.get_utc_now_iso", return_value="2026-08-01T10:05:00+00:00"):
            self.cli.cmd_finish(run_id="test-wall-clock-uuid")

        summary = self.storage.read_sanitized_summary("test-wall-clock-uuid")
        self.assertEqual(summary["timing"]["wall_clock_seconds"], 300.0)

    # Test 13: Agent active time is not guessed (remains null without telemetry)
    def test_no_agent_active_time_guessing(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        self.cli.cmd_finish(run_id=run_id)
        summary = self.storage.read_sanitized_summary(run_id)
        self.assertIsNone(summary["timing"]["agent_active_seconds"])

    # Test 14: System clock backward fail closed (never produces negative wall clock)
    def test_clock_backward_fail_closed(self):
        run_context = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "test-clock-backward-uuid",
            "work_package": "WP-CLOCK-BACKWARD",
            "started_at": "2026-08-01T10:10:00+00:00",
            "agent": {"shell": "Claude-Code", "provider": "Anthropic"},
        }
        self.storage.init_run(run_context)

        # Finished at earlier than started at due to clock skew
        with patch("agent_metrics.cli.get_utc_now_iso", return_value="2026-08-01T10:00:00+00:00"):
            self.cli.cmd_finish(run_id="test-clock-backward-uuid")

        summary = self.storage.read_sanitized_summary("test-clock-backward-uuid")
        self.assertEqual(summary["timing"]["wall_clock_seconds"], 0.0)


if __name__ == "__main__":
    unittest.main()
