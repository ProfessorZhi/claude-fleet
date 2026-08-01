"""
Claude Code Collector unit tests (Tests 15-25).
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector
from agent_metrics.correlation import SessionCorrelator, CorrelationConfidence


class TestClaudeCodeCollector(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.claude_dir = Path(self.temp_dir, ".claude")
        self.deepseek_dir = Path(self.temp_dir, ".claude-deepseek")
        self.minimax_dir = Path(self.temp_dir, ".claude-minimax")

        for d in [self.claude_dir, self.deepseek_dir, self.minimax_dir]:
            (d / "sessions").mkdir(parents=True, exist_ok=True)

        self.collector = ClaudeCodeCollector(
            custom_config_dirs=[self.claude_dir, self.deepseek_dir, self.minimax_dir]
        )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # Test 15: DeepSeek config dir detection
    def test_deepseek_config_dir_detection(self):
        sess_file = self.deepseek_dir / "sessions" / "sess1.json"
        sess_file.write_text(json.dumps({"session_id": "ds-01", "usage": {"total_tokens": 500}}))

        sessions = self.collector.scan_sessions()
        self.assertTrue(any(s["session_id"] == "ds-01" for s in sessions))

    # Test 16: MiniMax config dir detection
    def test_minimax_config_dir_detection(self):
        sess_file = self.minimax_dir / "sessions" / "sess2.json"
        sess_file.write_text(json.dumps({"session_id": "mm-01", "usage": {"total_tokens": 800}}))

        sessions = self.collector.scan_sessions()
        self.assertTrue(any(s["session_id"] == "mm-01" for s in sessions))

    # Test 17: Default .claude detection
    def test_default_claude_dir_detection(self):
        sess_file = self.claude_dir / "sessions" / "sess3.json"
        sess_file.write_text(json.dumps({"session_id": "cl-01", "usage": {"total_tokens": 1200}}))

        sessions = self.collector.scan_sessions()
        self.assertTrue(any(s["session_id"] == "cl-01" for s in sessions))

    # Test 18: Exact Session ID match
    def test_exact_session_match(self):
        sessions = [
            {"session_id": "target-session-99", "usage": {"total_tokens": 2000}},
            {"session_id": "other-session-00", "usage": {"total_tokens": 500}},
        ]
        matched, conf = SessionCorrelator.correlate_sessions(
            target_session_id="target-session-99",
            target_worktree=None,
            target_work_package=None,
            started_at_str="2026-08-01T10:00:00Z",
            finished_at_str="2026-08-01T10:10:00Z",
            available_sessions=sessions,
        )
        self.assertEqual(conf, CorrelationConfidence.EXACT_SESSION.value)
        self.assertEqual(matched["session_id"], "target-session-99")

    # Test 19: Worktree path match
    def test_worktree_match(self):
        sessions = [
            {"session_id": "sess-wt-1", "worktree": "F:\\projects\\mywork"},
        ]
        matched, conf = SessionCorrelator.correlate_sessions(
            target_session_id=None,
            target_worktree="F:\\projects\\mywork",
            target_work_package=None,
            started_at_str="2026-08-01T10:00:00Z",
            finished_at_str="2026-08-01T10:10:00Z",
            available_sessions=sessions,
        )
        self.assertEqual(conf, CorrelationConfidence.EXACT_WORKTREE.value)
        self.assertEqual(matched["session_id"], "sess-wt-1")

    # Test 20: Time window match
    def test_time_window_match(self):
        sessions = [
            {
                "session_id": "sess-tw-1",
                "started_at": "2026-08-01T10:02:00Z",
                "finished_at": "2026-08-01T10:08:00Z",
            }
        ]
        matched, conf = SessionCorrelator.correlate_sessions(
            target_session_id=None,
            target_worktree=None,
            target_work_package=None,
            started_at_str="2026-08-01T10:00:00Z",
            finished_at_str="2026-08-01T10:10:00Z",
            available_sessions=sessions,
        )
        self.assertEqual(conf, CorrelationConfidence.TIME_WINDOW_MATCH.value)
        self.assertEqual(matched["session_id"], "sess-tw-1")

    # Test 21: Multiple overlapping sessions returns AMBIGUOUS
    def test_ambiguous_session_match(self):
        sessions = [
            {"session_id": "s1", "started_at": "2026-08-01T10:02:00Z", "finished_at": "2026-08-01T10:08:00Z"},
            {"session_id": "s2", "started_at": "2026-08-01T10:03:00Z", "finished_at": "2026-08-01T10:09:00Z"},
        ]
        matched, conf = SessionCorrelator.correlate_sessions(
            target_session_id=None,
            target_worktree=None,
            target_work_package=None,
            started_at_str="2026-08-01T10:00:00Z",
            finished_at_str="2026-08-01T10:10:00Z",
            available_sessions=sessions,
        )
        self.assertEqual(conf, CorrelationConfidence.AMBIGUOUS.value)
        self.assertIsNone(matched)

    # Test 22: Transcript message prompt body is not saved
    def test_prompt_body_not_persisted(self):
        sess_file = self.claude_dir / "sessions" / "sess_prompt.json"
        sess_file.write_text(
            json.dumps(
                {
                    "session_id": "sess-prompt-01",
                    "prompt": "SECRET PROMPT TEXT DO NOT SAVE",
                    "messages": [{"role": "user", "content": "SECRET USER MESSAGE"}],
                    "usage": {"input_tokens": 100, "output_tokens": 50},
                }
            )
        )
        sessions = self.collector.scan_sessions()
        extracted = sessions[0]
        self.assertNotIn("prompt", extracted)
        self.assertNotIn("messages", extracted)

    # Test 23: Missing usage fields handled gracefully
    def test_missing_usage_fields(self):
        sess_file = self.claude_dir / "sessions" / "sess_sparse.json"
        sess_file.write_text(json.dumps({"session_id": "sess-sparse"}))
        sessions = self.collector.scan_sessions()
        extracted = sessions[0]
        self.assertIsNone(extracted["input_tokens"])
        self.assertIsNone(extracted["output_tokens"])

    # Test 24: Cache token extraction (read and write)
    def test_cache_tokens_extraction(self):
        sess_file = self.claude_dir / "sessions" / "sess_cache.json"
        sess_file.write_text(
            json.dumps(
                {
                    "session_id": "sess-cache",
                    "usage": {
                        "input_tokens": 1000,
                        "cache_read_tokens": 400,
                        "cache_write_tokens": 100,
                        "output_tokens": 200,
                    },
                }
            )
        )
        extracted = self.collector.scan_sessions()[0]
        self.assertEqual(extracted["cache_read_tokens"], 400)
        self.assertEqual(extracted["cache_write_tokens"], 100)

    # Test 25: Reasoning token extraction
    def test_reasoning_tokens_extraction(self):
        sess_file = self.claude_dir / "sessions" / "sess_reasoning.json"
        sess_file.write_text(
            json.dumps(
                {
                    "session_id": "sess-reasoning",
                    "usage": {"input_tokens": 1000, "output_tokens": 500, "reasoning_tokens": 300},
                }
            )
        )
        extracted = self.collector.scan_sessions()[0]
        self.assertEqual(extracted["reasoning_tokens"], 300)


if __name__ == "__main__":
    unittest.main()
