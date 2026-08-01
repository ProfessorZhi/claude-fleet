"""
Unit tests for Cockpit Collector safety contracts.
"""

import os
import unittest
from unittest.mock import patch, MagicMock

from agent_metrics.collectors.cockpit_collector import CockpitCollector, is_local_url
from agent_metrics.models import CollectorStatus


class TestCockpitCollectorSafety(unittest.TestCase):
    def test_fabricated_endpoints_absent(self):
        # Inspect source of CockpitCollector to confirm fake endpoints removed
        import inspect
        src = inspect.getsource(CockpitCollector)
        self.assertNotIn("/api/v1/quota", src)
        self.assertNotIn("/api/v1/usage/events", src)

    def test_local_url_validation(self):
        self.assertTrue(is_local_url("http://127.0.0.1:9090"))
        self.assertTrue(is_local_url("http://localhost:8080"))
        self.assertFalse(is_local_url("http://192.168.1.100:9090"))
        self.assertFalse(is_local_url("https://api.cockpit.example.com"))

    def test_doctor_does_not_consume_usage_queue(self):
        collector = CockpitCollector(config={"base_url": "http://127.0.0.1:9090"})
        with patch.object(collector, "probe_management_health", return_value=(False, None)):
            res = collector.collect(include_usage_queue=False)
            self.assertEqual(res["request_usage_surface"], "UNSUPPORTED")

    def test_management_key_not_sent_to_remote_or_unconfigured(self):
        with patch.dict(os.environ, {"COCKPIT_MANAGEMENT_KEY": "secret_key_123"}, clear=True):
            collector = CockpitCollector(config={"base_url": "http://192.168.1.5:9090"})
            is_healthy, _ = collector.probe_management_health()
            self.assertFalse(is_healthy)


if __name__ == "__main__":
    unittest.main()
