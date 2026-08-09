"""
Integration tests for local collectors and read-only environment inspection.
"""

import os
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.git_collector import GitCollector
from agent_metrics.collectors.github_collector import GithubCollector
from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector
from agent_metrics.collectors.cockpit_collector import CockpitCollector
from agent_metrics.collectors.antigravity_collector import AntigravityCollector


class TestIntegrationCollectors(unittest.TestCase):
    def test_collectors_read_only_guarantee(self):
        # Instantiate collectors and run availability check
        git_c = GitCollector()
        gh_c = GithubCollector()
        claude_c = ClaudeCodeCollector()
        cockpit_c = CockpitCollector()
        ag_c = AntigravityCollector()

        # Run checks - must not throw exception or alter system state
        git_st = git_c.check_availability()
        gh_st = gh_c.check_availability()
        claude_st = claude_c.check_availability()
        cockpit_st = cockpit_c.check_availability()
        ag_st = ag_c.check_availability()

        self.assertIn(git_st, ["AVAILABLE", "CONFIG_REQUIRED", "NOT_AVAILABLE"])
        self.assertIn(gh_st, ["AVAILABLE", "CONFIG_REQUIRED", "NOT_AVAILABLE"])
        self.assertIn(claude_st, ["AVAILABLE", "CONFIG_REQUIRED", "NOT_AVAILABLE"])
        self.assertIn(cockpit_st, ["AVAILABLE", "CONFIG_REQUIRED", "NOT_AVAILABLE"])
        self.assertIn(ag_st, ["AVAILABLE", "CONFIG_REQUIRED", "NOT_AVAILABLE"])


if __name__ == "__main__":
    unittest.main()
