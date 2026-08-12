import json
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from agent_metrics.fleet_collectors import (
    collector_observations_from_summary,
    telemetry_envelope_from_local_report,
)
from test_fleet_usage_boundary import _summary


class FleetCollectorContractTests(unittest.TestCase):
    def test_local_report_exposes_four_independent_metrics(self):
        summary = _summary()
        summary["pricing"] = {
            "currency": "USD",
            "api_equivalent_cost_usd": 0.12,
            "actual_billed_cost_usd": None,
            "status": "CALCULATED",
        }

        report = collector_observations_from_summary(summary, usage_id="usage-collector-1")

        self.assertEqual(report["usage"]["availability"], "available")
        self.assertEqual(report["duration"]["value"], 10500)
        self.assertEqual(report["cost"]["value"]["basis"], "api-equivalent")
        self.assertEqual(report["cost"]["estimateOrActual"], "estimate")
        self.assertEqual(report["quota"]["availability"], "unavailable")
        self.assertNotIn("value", report["quota"])

    def test_unavailable_usage_does_not_become_zero_or_fake_cost(self):
        summary = _summary(status="NOT_AVAILABLE")
        report = collector_observations_from_summary(summary, usage_id="usage-collector-2")
        envelope = telemetry_envelope_from_local_report(summary, usage_id="usage-collector-2")

        self.assertEqual(report["usage"]["availability"], "unavailable")
        self.assertEqual(report["cost"]["availability"], "unavailable")
        self.assertNotIn("usage", envelope)
        self.assertEqual(envelope["quota"]["availability"], "unavailable")

    def test_output_is_bounded_and_contains_no_raw_report_or_secret(self):
        summary = _summary()
        summary["agent"]["api_key"] = "sk-test-secret"
        report = collector_observations_from_summary(summary, usage_id="usage-collector-3")
        encoded = json.dumps(report, sort_keys=True)

        self.assertNotIn("api_key", encoded)
        self.assertNotIn("sk-test-secret", encoded)
        self.assertNotIn("fleet_run_id", encoded)


if __name__ == "__main__":
    unittest.main()
