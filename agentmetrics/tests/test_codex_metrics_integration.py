"""
Integration tests: Codex quota wiring into Start / Finish.

Scenarios 9-11:
    - Start persists a sanitized Before snapshot for Codex agents.
    - Finish persists an After snapshot and a Delta.
    - Finish is idempotent — second call MUST NOT re-capture quota.
"""

import io
import json
import os
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


def _extract_run_id(output):
    for line in output.splitlines():
        if line.startswith("RUN_ID="):
            return line[len("RUN_ID="):].strip()
    # JSON mode
    s = output.find("{")
    e = output.rfind("}")
    if s >= 0 and e > s:
        try:
            return str(json.loads(output[s:e + 1]).get("run_id"))
        except Exception:
            return None
    return None


def _fake_snapshot_factory(pairs):
    """Return a callable that mimics CodexQuotaCollector.capture_snapshot.

    ``pairs`` is a list of (call_count, snapshot) tuples; each successive
    capture pops the next item. Returns a sentinel marker when exhausted.
    """
    counter = {"n": 0}

    def fake_capture(self):
        idx = counter["n"]
        counter["n"] += 1
        if idx >= len(pairs):
            return {
                "status": "NOT_AVAILABLE",
                "captured_at": "2026-08-01T10:00:00+00:00",
                "account_ref_hash": None,
                "plan_type": None,
                "percentage_semantics": "unknown",
                "primary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
                "secondary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
            }
        return pairs[idx]

    return fake_capture


class TestCodexStartFinishIntegration(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _start_codex(self):
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(
                agent_shell="Codex",
                provider="OpenAI",
                configured_model="gpt-5-codex",
                work_package="WP-CODEX-01",
            )
        return _extract_run_id(out.getvalue())

    def test_start_persists_sanitized_before_snapshot(self):
        before = {
            "status": "COMPLETE",
            "captured_at": "2026-08-01T10:00:00+00:00",
            "account_ref_hash": "deadbeefdeadbeef",
            "plan_type": "plus",
            "percentage_semantics": "remaining",
            "primary_window": {
                "percentage": 80.0,
                "window_minutes": 180,
                "reset_at": "2026-08-01T13:00:00+00:00",
            },
            "secondary_window": {
                "percentage": 90.0,
                "window_minutes": 10080,
                "reset_at": "2026-08-08T10:00:00+00:00",
            },
        }

        capture_calls = {"n": 0}

        def fake_capture(self):
            capture_calls["n"] += 1
            return json.loads(json.dumps(before))

        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            run_id = self._start_codex()

        ctx = self.storage.read_run_context(run_id)
        self.assertIn("codex_quota", ctx)
        self.assertEqual(capture_calls["n"], 1)
        # Allowlist honored: only persistable fields remain.
        stored = ctx["codex_quota"]["before"]
        self.assertEqual(stored["percentage_semantics"], "remaining")
        self.assertEqual(stored["account_ref_hash"], "deadbeefdeadbeef")
        self.assertEqual(stored["primary_window"]["percentage"], 80.0)
        self.assertEqual(stored["status"], "COMPLETE")

    def test_finish_writes_after_and_delta(self):
        before = {
            "status": "COMPLETE",
            "captured_at": "2026-08-01T10:00:00+00:00",
            "account_ref_hash": "deadbeefdeadbeef",
            "plan_type": "plus",
            "percentage_semantics": "remaining",
            "primary_window": {
                "percentage": 80.0,
                "window_minutes": 180,
                "reset_at": "2026-08-01T13:00:00+00:00",
            },
            "secondary_window": {
                "percentage": 90.0,
                "window_minutes": 10080,
                "reset_at": "2026-08-08T10:00:00+00:00",
            },
        }
        after = json.loads(json.dumps(before))
        after["captured_at"] = "2026-08-01T10:05:00+00:00"
        after["primary_window"]["percentage"] = 70.0
        after["secondary_window"]["percentage"] = 88.0

        # Queue: start takes before, finish takes after.
        queue = [json.loads(json.dumps(s)) for s in (before, after)]
        capture_calls = {"n": 0}

        def fake_capture(self):
            capture_calls["n"] += 1
            if not queue:
                # Default skeleton for any extra capture
                return {
                    "status": "NOT_AVAILABLE",
                    "captured_at": "2026-08-01T10:00:00+00:00",
                    "account_ref_hash": None,
                    "plan_type": None,
                    "percentage_semantics": "unknown",
                    "primary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
                    "secondary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
                }
            return queue.pop(0)

        # Start captures Before (queue[0])
        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            run_id = self._start_codex()

        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            with patch("sys.stdout", new=io.StringIO()):
                code = self.cli.cmd_finish(run_id=run_id)

        self.assertEqual(code, 0)
        # Finish must call capture_snapshot exactly once (the After capture).
        self.assertEqual(capture_calls["n"], 2, "Start (1) + Finish (1) = 2 capture_snapshot calls")

        summary = self.storage.read_sanitized_summary(run_id)
        quota = summary["quota"]
        self.assertEqual(quota["before"]["percentage_semantics"], "remaining")
        self.assertEqual(quota["after"]["primary_window"]["percentage"], 70.0)
        self.assertIsNotNone(quota["delta"])
        # remaining semantics: consumed = before - after = 10.0
        self.assertAlmostEqual(quota["delta"]["primary_consumed_percentage"], 10.0)
        self.assertAlmostEqual(quota["delta"]["secondary_consumed_percentage"], 2.0)
        self.assertEqual(quota["delta"]["delta_status"], "COMPLETE")

    def test_second_finish_does_not_recapture(self):
        before = {
            "status": "COMPLETE",
            "captured_at": "2026-08-01T10:00:00+00:00",
            "account_ref_hash": "deadbeefdeadbeef",
            "plan_type": "plus",
            "percentage_semantics": "remaining",
            "primary_window": {
                "percentage": 80.0,
                "window_minutes": 180,
                "reset_at": "2026-08-01T13:00:00+00:00",
            },
            "secondary_window": {
                "percentage": 90.0,
                "window_minutes": 10080,
                "reset_at": "2026-08-08T10:00:00+00:00",
            },
        }
        after = json.loads(json.dumps(before))
        after["primary_window"]["percentage"] = 60.0
        after["secondary_window"]["percentage"] = 80.0

        # Queue holds two captures: Start (Before) and first Finish (After).
        # The second Finish MUST NOT consume a queue slot.
        queue = [json.loads(json.dumps(s)) for s in (before, after)]
        capture_calls = {"n": 0}

        def fake_capture(self):
            capture_calls["n"] += 1
            if not queue:
                return {
                    "status": "NOT_AVAILABLE",
                    "captured_at": "2026-08-01T10:00:00+00:00",
                    "account_ref_hash": None,
                    "plan_type": None,
                    "percentage_semantics": "unknown",
                    "primary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
                    "secondary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
                }
            return queue.pop(0)

        # Start
        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            run_id = self._start_codex()

        # First Finish
        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            with patch("sys.stdout", new=io.StringIO()):
                self.cli.cmd_finish(run_id=run_id)

        s1 = self.storage.read_sanitized_summary(run_id)
        first_sha = s1.get("integrity", {}).get("payload_sha256")
        calls_after_first_finish = capture_calls["n"]

        # Second Finish: capture_snapshot MUST NOT be called.
        with patch("agent_metrics.cli.CodexQuotaCollector.capture_snapshot", new=fake_capture):
            with patch("sys.stdout", new=io.StringIO()):
                self.cli.cmd_finish(run_id=run_id)

        self.assertEqual(capture_calls["n"], calls_after_first_finish,
                         "Idempotent finish must not re-capture quota")

        s2 = self.storage.read_sanitized_summary(run_id)
        self.assertEqual(s2.get("integrity", {}).get("payload_sha256"), first_sha,
                         "Idempotent finish must keep summary bytes identical")


if __name__ == "__main__":
    unittest.main()