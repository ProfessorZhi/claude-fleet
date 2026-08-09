import unittest

from agent_metrics.collectors.cockpit_report_http_collector import (
    build_provider_snapshot,
    parse_report_yaml_rows,
)


REPORT = '''
generated_at: "2026-08-01T11:38:07+00:00"
rows:
  - service: "Codex"
    account: "acct-redacted"
    metric: "Main window (7d)"
    used: "46%"
    remaining: "54%"
    reset_cycle: "2026-08-07T01:39:58+00:00"
    status: "normal"
  - service: "Codex"
    account: "acct-redacted"
    metric: "Weekly window"
    used: "68%"
    remaining: "32%"
    reset_cycle: "2026-08-07T04:04:16+00:00"
    status: "normal"
  - service: "Antigravity IDE"
    account: "acct-redacted"
    metric: "Five Hour Limit"
    used: "0%"
    remaining: "100%"
    reset_cycle: "2026-08-01T16:35:52+00:00"
    status: "normal"
'''


class TestCockpitReportHttpCollector(unittest.TestCase):
    def test_parse_report_rows(self):
        rows = parse_report_yaml_rows(REPORT)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["service"], "Codex")
        self.assertEqual(rows[0]["remaining"], "54%")

    def test_codex_snapshot_from_report(self):
        snap = build_provider_snapshot(parse_report_yaml_rows(REPORT), "OpenAI")
        self.assertEqual(snap["source"], "cockpit_report_http")
        self.assertEqual(snap["status"], "COMPLETE")
        self.assertEqual(snap["primary_window"]["percentage"], 54.0)
        self.assertEqual(snap["secondary_window"]["percentage"], 32.0)
        self.assertIsNotNone(snap["account_ref_hash"])
        self.assertNotIn("acct-redacted", str(snap))


if __name__ == "__main__":
    unittest.main()
