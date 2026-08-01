"""
Unit tests for Claude Code Collector streaming JSONL transcript parser and baseline privacy.
"""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector, is_valid_session_id
from agent_metrics.models import CollectorStatus


class TestClaudeCodeCollectorStream(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.claude_dir = Path(self.temp_dir) / "custom-claude-config-dir"
        self.projects_dir = self.claude_dir / "projects" / "C--Users-PrivateUser-secret-project"
        self.projects_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_real_jsonl_stream_deduplication(self):
        jsonl_file = self.projects_dir / "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
        lines = [
            json.dumps({"type": "user", "timestamp": "2026-08-01T10:00:00Z"}),
            json.dumps({
                "type": "assistant",
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "timestamp": "2026-08-01T10:00:05Z",
                "message": {
                    "id": "msg-001",
                    "model": "claude-3-5-sonnet-20241022",
                    "usage": {"input_tokens": 100, "output_tokens": 10}
                }
            }),
            json.dumps({
                "type": "assistant",
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "timestamp": "2026-08-01T10:00:10Z",
                "message": {
                    "id": "msg-001",
                    "model": "claude-3-5-sonnet-20241022",
                    "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 20}
                }
            }),
            json.dumps({
                "type": "assistant",
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
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
        self.assertEqual(res["session_id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        self.assertEqual(res["observed_model"], "claude-3-5-sonnet-20241022")
        self.assertEqual(res["input_tokens"], 300)
        self.assertEqual(res["output_tokens"], 80)
        self.assertEqual(res["cache_read_tokens"], 20)
        self.assertEqual(res["total_tokens"], 380)

    def test_prompt_content_not_extracted(self):
        jsonl_file = self.projects_dir / "bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl"
        lines = [
            json.dumps({
                "type": "user",
                "text": "Sensitive User Prompt Text",
                "timestamp": "2026-08-01T10:00:00Z"
            }),
            json.dumps({
                "type": "assistant",
                "sessionId": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
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

    def test_create_session_baseline_privacy(self):
        sess_id = "11111111-2222-3333-4444-555555555555"
        jsonl_file = self.projects_dir / f"{sess_id}.jsonl"
        jsonl_file.write_text('{"type":"user","timestamp":"2026-08-01T10:00:00Z"}\n', encoding="utf-8")

        with patch("pathlib.Path.home", return_value=Path(self.temp_dir)):
            collector = ClaudeCodeCollector(config={"claude_config_dir": str(self.claude_dir)})
            baseline = collector.create_session_baseline()

        self.assertEqual(len(baseline), 1)
        entry = baseline[0]

        self.assertEqual(set(entry.keys()), {"config_dir_name", "session_id", "file_size", "last_modified"})
        self.assertEqual(entry["config_dir_name"], "custom")
        self.assertEqual(entry["session_id"], sess_id)

        serialized = json.dumps(entry)
        self.assertNotIn("file_path", entry)
        self.assertNotIn("relative_path", entry)
        self.assertNotIn("PrivateUser", serialized)
        self.assertNotIn(".claude-deepseek", serialized)
        self.assertNotIn("projects", serialized)
        self.assertNotIn("C--Users", serialized)
        self.assertNotIn(".jsonl", serialized)

    def test_is_valid_session_id_validator(self):
        valid_uuids = [
            "11111111-2222-3333-4444-555555555555",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "session_123.test",
        ]
        for sid in valid_uuids:
            self.assertTrue(is_valid_session_id(sid), f"Expected valid: {sid}")

        invalid_ids = [
            "",
            ".",
            "..",
            "bad name",
            "C--Users-PrivateUser",
            "C:\\Users\\PrivateUser",
            "path/to/file",
            "path\\to\\file",
            "session:123",
            "session\t123",
            "session\n123",
            "--Users-folder",
            "-home-folder",
            "a" * 129,
        ]
        for sid in invalid_ids:
            self.assertFalse(is_valid_session_id(sid), f"Expected invalid: {sid}")


if __name__ == "__main__":
    unittest.main()
