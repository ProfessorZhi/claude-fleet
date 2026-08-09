import json
import unittest

from agent_metrics.collectors.cockpit_local_snapshot_collector import cockpit_antigravity_quota_snapshot


class TestCockpitLocalSnapshotCollector(unittest.TestCase):
    def test_antigravity_quota_allowlist(self):
        snap = cockpit_antigravity_quota_snapshot({
            "provider": "Google",
            "account_id": "acct-raw",
            "email": "drop-redacted",
            "plan_type": "pro",
            "quota": {
                "remaining_fraction": 0.7,
                "reset_at": "2026-08-01T00:00:00Z",
                "model_quotas": [{"model": "gemini", "percentage": 70.0}],
            },
        })
        text = json.dumps(snap)
        self.assertEqual(snap["status"], "COMPLETE")
        self.assertNotIn("acct-raw", text)
        self.assertNotIn("drop-redacted", text)

    def test_credential_export_rejected(self):
        snap = cockpit_antigravity_quota_snapshot({"access_token": "secret", "quota": {}})
        self.assertEqual(snap["status"], "CREDENTIAL_EXPORT_REJECTED")


if __name__ == "__main__":
    unittest.main()
