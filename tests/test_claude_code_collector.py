"""
Unit tests for Claude Code Collector streaming JSONL transcript parser.
"""

import json
import tempfile
import shutil
import unittest
from pathlib import Path

from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector
from agent_metrics.models import CollectorStatus


class TestClaudeCodeCollectorStream(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.claude_dir = Path(self.temp_dir) / ".claude"
        self.projects_dir = self.claude_dir / "projects" / "test-project"
        self.projects_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_real_jsonl_stream_deduplication(self):
        jsonl_file = self.projects_dir / "sess-123.jsonl"
        lines = [
            json.dumps({"type": "user", "timestamp": "2026-08-01T10:00:00Z"}),
            # Streaming assistant chunk 1
            json.dumps({
                "type": "assistant",
                "sessionId": "sess-123",
                "timestamp": "2026-08-01T10:00:05Z",
                "message": {
                    "id": "msg-001",
                    "model": "claude-3-5-sonnet-20241022",
                    "usage": {"input_tokens": 100, "output_tokens": 10}
                }
            }),
            # Streaming assistant chunk 2 (same message ID, final tokens)
            json.dumps({
                "type": "assistant",
                "sessionId": "sess-123",
                "timestamp": "2026-08-01T10:00:10Z",
                "message": {
                    "id": "msg-001",
                    "model": "claude-3-5-sonnet-20241022",
                    "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 20}
                }
            }),
            # Second message
            json.dumps({
                "type": "assistant",
                "sessionId": "sess-123",
                "timestamp": "2026-08-01T10:01:00Z",
                "message": {
                    "id": "msg-002",
                    "model": "claude-3-5-sonnet-20241022",
                    "usage": {"input_tokens": 200, "output_tokens": 30}
                }
            }),
        ]
        jsonl_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

        collector = ClaudeCodeCollector()
        res = collector.parse_transcript_line_by_line(jsonl_file)
        self.assertIsNotNone(res)
        self.assertEqual(res["session_id"], "sess-123")
        self.assertEqual(res["observed_model"], "claude-3-5-sonnet-20241022")
        # msg-001 (100, 50, 20 cache) + msg-002 (200, 30) = 300 input, 80 output
        self.assertEqual(res["input_tokens"], 300)
        self.assertEqual(res["output_tokens"], 80)
        self.assertEqual(res["cache_read_tokens"], 20)
        self.assertEqual(res["total_tokens"], 380)

    def test_prompt_content_not_extracted(self):
        jsonl_file = self.projects_dir / "sess-456.jsonl"
        lines = [
            json.dumps({
                "type": "user",
                "text": "Sensitive User Prompt Text",
                "timestamp": "2026-08-01T10:00:00Z"
            }),
            json.dumps({
                "type": "assistant",
                "sessionId": "sess-456",
                "timestamp": "2026-08-01T10:00:05Z",
                "message": {
                    "id": "msg-001",
                    "model": "MiniMax-M2.7",
                    "content": "Sensitive Assistant Response",
                    "usage": {"input_tokens": 50, "output_tokens": 20}
                }
            }),
        ]
        jsonl_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

        collector = ClaudeCodeCollector()
        res = collector.parse_transcript_line_by_line(jsonl_file)
        self.assertNotIn("text", res)
        self.assertNotIn("content", res)
        self.assertEqual(res["input_tokens"], 50)
        self.assertEqual(res["output_tokens"], 20)


if __name__ == "__main__":
    unittest.main()
