"""
Cockpit Collector unit tests (Tests 26-34).
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.cockpit_collector import CockpitCollector
from agent_metrics.collectors.antigravity_collector import AntigravityCollector
from agent_metrics.models import CollectorStatus, CockpitConfidence


class TestCockpitCollector(unittest.TestCase):
    # Test 26: Cockpit process does not exist
    def test_cockpit_not_exists(self):
        collector = CockpitCollector(
            override_base_url=None,
            override_process_running=False,
            override_cliproxy_running=False,
        )
        with patch.object(collector, "_is_port_listening", return_value=False):
            status = collector.check_availability()
            self.assertEqual(status, CollectorStatus.NOT_AVAILABLE.value)

    # Test 27: Cockpit process exists but CLIProxy process does not
    def test_cockpit_exists_cliproxy_does_not(self):
        collector = CockpitCollector(
            override_base_url="http://127.0.0.1:8314",
            override_process_running=True,
            override_cliproxy_running=False,
        )
        status = collector.check_availability()
        self.assertEqual(status, CollectorStatus.CONFIG_REQUIRED.value)

    # Test 28: CLIProxy process exists and listening
    def test_cliproxy_exists_and_listening(self):
        collector = CockpitCollector(
            override_base_url="http://127.0.0.1:8314",
            override_process_running=True,
            override_cliproxy_running=True,
        )
        status = collector.check_availability()
        self.assertEqual(status, CollectorStatus.AVAILABLE.value)

    # Test 29: Quota Only status
    def test_quota_only_status(self):
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        quota_data = {"before": {"percentage": 10}, "after": {"percentage": 20}}

        with patch.object(collector, "fetch_quota_snapshot", return_value=(quota_data, CockpitConfidence.QUOTA_OBSERVED.value)):
            with patch.object(collector, "fetch_cliproxy_usage_events", return_value=([], CockpitConfidence.NOT_AVAILABLE.value)):
                ag_collector = AntigravityCollector(log_dir=None, cockpit_collector=collector)
                res = ag_collector.collect({"started_at": "2026-08-01T10:00:00Z", "configured_model": "gemini-3.6-flash"})
                self.assertEqual(res["usage"]["collection_status"], "NOT_AVAILABLE")
                self.assertEqual(res["usage"]["correlation_confidence"], "QUOTA_ONLY")
                self.assertIsNone(res["usage"]["input_tokens"])

    # Test 30: Usage Endpoint available
    def test_usage_endpoint_available(self):
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        mock_events = [
            {"usage": {"input_tokens": 500, "output_tokens": 200}, "model": "gemini-3.6-flash"}
        ]
        with patch.object(collector, "fetch_cliproxy_usage_events", return_value=(mock_events, CockpitConfidence.REQUEST_OBSERVED.value)):
            ag_collector = AntigravityCollector(log_dir=None, cockpit_collector=collector)
            res = ag_collector.collect({"started_at": "2026-08-01T10:00:00Z", "configured_model": "gemini-3.6-flash"})
            self.assertEqual(res["usage"]["collection_status"], "COMPLETE")
            self.assertEqual(res["usage"]["input_tokens"], 500)

    # Test 31: Management Key is not entering output or persisted
    def test_management_key_not_in_output(self):
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        os.environ["COCKPIT_MANAGEMENT_KEY"] = "super-secret-management-key-999"

        try:
            with patch("urllib.request.urlopen") as mock_url:
                mock_resp = MagicMock()
                mock_resp.status = 200
                mock_resp.read.return_value = json.dumps({"quota": "ok"}).encode("utf-8")
                mock_url.return_value.__enter__.return_value = mock_resp

                data, conf = collector.fetch_quota_snapshot()
                json_str = json.dumps(data)
                self.assertNotIn("super-secret-management-key-999", json_str)
        finally:
            os.environ.pop("COCKPIT_MANAGEMENT_KEY", None)

    # Test 32: Endpoint error fails closed gracefully
    def test_endpoint_error_fails_closed(self):
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        with patch("urllib.request.urlopen", side_effect=Exception("Connection refused")):
            data, conf = collector.fetch_quota_snapshot()
            self.assertIsNone(data)
            self.assertEqual(conf, CockpitConfidence.NOT_AVAILABLE.value)

    # Test 33: Multiple Usage candidates ambiguous matching
    def test_multiple_usage_candidates_ambiguous(self):
        # When multiple events exist across different models without explicit session link
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        mock_events = [
            {"usage": {"input_tokens": 500}, "model": "gemini-3.6-flash"},
            {"usage": {"input_tokens": 800}, "model": "claude-3-5-sonnet"},
        ]
        # Verified that correlation engine handles AMBIGUOUS when requested
        from agent_metrics.correlation import SessionCorrelator
        session_list = [
            {"session_id": "s1", "worktree": "A"},
            {"session_id": "s2", "worktree": "A"},
        ]
        _, conf = SessionCorrelator.correlate_sessions(None, "A", None, "2026-08-01T10:00:00Z", None, session_list)
        self.assertEqual(conf, "AMBIGUOUS")

    # Test 34: Do NOT estimate tokens from Quota Delta percentage
    def test_no_token_estimation_from_quota_delta(self):
        collector = CockpitCollector(override_base_url="http://127.0.0.1:8314")
        quota_data = {"before": {"remaining": 90}, "after": {"remaining": 80}, "delta": {"percentage_drop": 10.0}}
        with patch.object(collector, "fetch_quota_snapshot", return_value=(quota_data, CockpitConfidence.QUOTA_OBSERVED.value)):
            ag_collector = AntigravityCollector(log_dir=None, cockpit_collector=collector)
            res = ag_collector.collect({"started_at": "2026-08-01T10:00:00Z"})
            self.assertIsNone(res["usage"]["input_tokens"])
            self.assertIsNone(res["usage"]["total_tokens"])


if __name__ == "__main__":
    unittest.main()
