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

from agent_metrics.fleet_ingest import telemetry_envelope_from_summary
from agent_metrics.fleet_boundary import FleetBoundaryError
from test_fleet_usage_boundary import _summary


class FleetIngestTests(unittest.TestCase):
    def test_summary_becomes_usage_and_explicit_unavailable_quota(self):
        envelope = telemetry_envelope_from_summary(_summary(), usage_id="usage-ingest-1")

        self.assertEqual(envelope["usage"]["usageId"], "usage-ingest-1")
        self.assertEqual(envelope["usage"]["instanceId"], "worker-001")
        self.assertEqual(envelope["quota"]["availability"], "unavailable")
        self.assertEqual(envelope["quota"]["confidence"], "unknown")
        self.assertNotIn("remaining", envelope["quota"])
        encoded = json.dumps(envelope, sort_keys=True)
        self.assertNotIn("fleet_run_id", encoded)
        self.assertNotIn("api_key", encoded)

    def test_unavailable_usage_still_exports_quota_context_without_fabricating_usage(self):
        envelope = telemetry_envelope_from_summary(
            _summary(status="NOT_AVAILABLE"),
            usage_id="usage-not-published",
        )

        self.assertNotIn("usage", envelope)
        self.assertEqual(envelope["quota"]["availability"], "unavailable")

    def test_invalid_summary_stays_fail_closed(self):
        summary = _summary()
        summary["usage"]["collection_status"] = "NOT_A_STATUS"
        with self.assertRaises(ValueError):
            telemetry_envelope_from_summary(summary, usage_id="usage-invalid")

    def test_quota_percentages_are_not_promoted_to_numeric_fleet_quota(self):
        envelope = telemetry_envelope_from_summary(_summary(), usage_id="usage-percent")
        quota = envelope["quota"]
        self.assertEqual(quota["availability"], "unavailable")
        self.assertNotIn("limit", quota)
        self.assertNotIn("used", quota)
        self.assertNotIn("remaining", quota)


if __name__ == "__main__":
    unittest.main()
