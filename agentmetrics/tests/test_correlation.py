"""
Session correlation unit tests.
"""

import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.correlation import SessionCorrelator, CorrelationConfidence


class TestCorrelation(unittest.TestCase):
    def test_correlate_by_session_id(self):
        sessions = [{"session_id": "s-123"}, {"session_id": "s-456"}]
        match, conf = SessionCorrelator.correlate_sessions("s-123", None, None, "2026-08-01T10:00:00Z", None, sessions)
        self.assertEqual(conf, CorrelationConfidence.EXACT_SESSION.value)
        self.assertEqual(match["session_id"], "s-123")

    def test_correlate_by_work_package(self):
        sessions = [{"session_id": "s-1", "work_package": "WP-ALPHA"}]
        match, conf = SessionCorrelator.correlate_sessions(None, None, "WP-ALPHA", "2026-08-01T10:00:00Z", None, sessions)
        self.assertEqual(conf, CorrelationConfidence.EXACT_WORK_PACKAGE.value)
        self.assertEqual(match["session_id"], "s-1")

    def test_correlate_empty_sessions(self):
        match, conf = SessionCorrelator.correlate_sessions("s-1", None, None, "2026-08-01T10:00:00Z", None, [])
        self.assertEqual(conf, CorrelationConfidence.NOT_AVAILABLE.value)
        self.assertIsNone(match)


if __name__ == "__main__":
    unittest.main()
