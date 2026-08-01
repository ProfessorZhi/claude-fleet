"""
Integration tests for GitHub CLI collector and mock scenarios (Phase 3.3).
"""

import json
import sys
import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.github_collector import GithubCollector


class TestIntegrationGithub(unittest.TestCase):
    def setUp(self):
        self.collector = GithubCollector()

    # Test Open Draft PR
    def test_open_draft_pr(self):
        mock_pr = {
            "number": 56,
            "url": "https://github.com/ProfessorZhi/Zuno/pull/56",
            "baseRefName": "main",
            "headRefName": "feature/draft",
            "headRefOid": "abc123sha",
            "state": "OPEN",
            "isDraft": True,
            "commits": [{"oid": "c1"}],
            "changedFiles": 3,
            "additions": 50,
            "deletions": 10,
        }
        mock_runs = [
            {
                "databaseId": 999111,
                "createdAt": "2026-08-01T10:00:00Z",
                "updatedAt": "2026-08-01T10:05:00Z",
                "status": "completed",
                "conclusion": "success",
            }
        ]

        def _mock_gh_json(args, cwd=None):
            if "pr" in args:
                return mock_pr
            elif "run" in args:
                return mock_runs
            return None

        with patch.object(self.collector, "_run_gh_json", side_effect=_mock_gh_json):
            info = self.collector.query_pr_details("ProfessorZhi/Zuno", 56)
            self.assertEqual(info.pr_number, 56)
            self.assertTrue(info.is_draft)
            self.assertEqual(info.state, "OPEN")
            self.assertEqual(info.ci_run_id, "999111")
            self.assertEqual(info.ci_result, "success")
            self.assertEqual(info.ci_duration_seconds, 300.0)

    # Test Merged PR & CI Failure
    def test_merged_pr_ci_failure(self):
        mock_pr = {
            "number": 57,
            "url": "https://github.com/ProfessorZhi/Zuno/pull/57",
            "baseRefName": "main",
            "headRefName": "feature/fix",
            "headRefOid": "def456sha",
            "state": "MERGED",
            "isDraft": False,
            "commits": [{"oid": "c1"}, {"oid": "c2"}],
            "changedFiles": 1,
            "additions": 5,
            "deletions": 2,
        }
        mock_runs = [
            {
                "databaseId": 999222,
                "createdAt": "2026-08-01T11:00:00Z",
                "updatedAt": "2026-08-01T11:02:00Z",
                "status": "completed",
                "conclusion": "failure",
            }
        ]

        def _mock_gh_json(args, cwd=None):
            if "pr" in args:
                return mock_pr
            elif "run" in args:
                return mock_runs
            return None

        with patch.object(self.collector, "_run_gh_json", side_effect=_mock_gh_json):
            info = self.collector.query_pr_details("ProfessorZhi/Zuno", 57)
            self.assertEqual(info.state, "MERGED")
            self.assertEqual(info.ci_result, "failure")
            self.assertEqual(info.commit_count, 2)

    # Test gh CLI logged out / failure
    def test_gh_logged_out(self):
        with patch.object(self.collector, "_run_gh_json", return_value=None):
            info = self.collector.query_pr_details("ProfessorZhi/Zuno", 99)
            self.assertEqual(info.pr_number, 99)
            self.assertIsNone(info.state)
            self.assertIsNone(info.ci_run_id)


if __name__ == "__main__":
    unittest.main()
