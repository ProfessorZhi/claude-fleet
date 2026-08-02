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

    def test_explicit_session_id_counts_only_that_session(self):
        sid_a = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        sid_b = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        (self.projects_dir / f"{sid_a}.jsonl").write_text(
            json.dumps({
                "type": "assistant",
                "sessionId": sid_a,
                "timestamp": "2026-08-01T10:00:00Z",
                "message": {"id": "a-1", "usage": {"input_tokens": 10, "output_tokens": 2}},
            }) + "\n",
            encoding="utf-8",
        )
        (self.projects_dir / f"{sid_b}.jsonl").write_text(
            json.dumps({
                "type": "assistant",
                "sessionId": sid_b,
                "timestamp": "2026-08-01T10:00:00Z",
                "message": {"id": "b-1", "usage": {"input_tokens": 99, "output_tokens": 9}},
            }) + "\n",
            encoding="utf-8",
        )

        collector = ClaudeCodeCollector(config={"claude_config_dir": str(self.claude_dir)})
        res = collector.collect(run_context={
            "agent_session_id": sid_a,
            "session_cursor_before": {
                "config_dir_name": "custom",
                "session_id": sid_a,
                "jsonl_size_before": 0,
                "known_message_id_hashes_before": [],
            },
            "require_exact_session": True,
        })

        self.assertEqual(res["correlation_confidence"], "EXACT_SESSION_AND_CURSOR")
        self.assertEqual(res["matched_session"]["session_id"], sid_a)
        self.assertEqual(res["matched_session"]["input_tokens"], 10)

    def test_same_worktree_two_sessions_without_id_is_ambiguous(self):
        for sid in ("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"):
            (self.projects_dir / f"{sid}.jsonl").write_text(
                json.dumps({
                    "type": "assistant",
                    "sessionId": sid,
                    "timestamp": "2026-08-01T10:00:00Z",
                    "cwd": "F:/repo",
                    "message": {"id": sid, "usage": {"input_tokens": 1, "output_tokens": 1}},
                }) + "\n",
                encoding="utf-8",
            )

        collector = ClaudeCodeCollector(config={"claude_config_dir": str(self.claude_dir)})
        res = collector.collect(run_context={"worktree": "F:/repo"})

        self.assertEqual(res["correlation_confidence"], "AMBIGUOUS")
        self.assertIsNone(res["matched_session"])

    def test_cursor_counts_only_incremental_segment(self):
        sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        first = json.dumps({
            "type": "assistant",
            "sessionId": sid,
            "timestamp": "2026-08-01T10:00:00Z",
            "message": {"id": "m-1", "usage": {"input_tokens": 100, "output_tokens": 10}},
        }) + "\n"
        second = json.dumps({
            "type": "assistant",
            "sessionId": sid,
            "timestamp": "2026-08-01T10:01:00Z",
            "message": {"id": "m-2", "usage": {"input_tokens": 20, "output_tokens": 3}},
        }) + "\n"
        jsonl_file = self.projects_dir / f"{sid}.jsonl"
        jsonl_file.write_text(first + second, encoding="utf-8")

        collector = ClaudeCodeCollector(config={"claude_config_dir": str(self.claude_dir)})
        res = collector.parse_transcript_line_by_line(
            jsonl_file,
            cursor_before={
                "config_dir_name": "custom",
                "session_id": sid,
                "jsonl_size_before": len(first.encode("utf-8")),
                "known_message_id_hashes_before": [],
            },
        )

        self.assertEqual(res["input_tokens"], 20)
        self.assertEqual(res["output_tokens"], 3)

    def test_cursor_message_id_dedupes_replayed_history(self):
        sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        jsonl_file = self.projects_dir / f"{sid}.jsonl"
        first = json.dumps({
            "type": "assistant",
            "sessionId": sid,
            "timestamp": "2026-08-01T10:00:00Z",
            "message": {"id": "m-1", "usage": {"input_tokens": 100, "output_tokens": 10}},
        }) + "\n"
        replay = json.dumps({
            "type": "assistant",
            "sessionId": sid,
            "timestamp": "2026-08-01T10:01:00Z",
            "message": {"id": "m-1", "usage": {"input_tokens": 100, "output_tokens": 10}},
        }) + "\n"
        new = json.dumps({
            "type": "assistant",
            "sessionId": sid,
            "timestamp": "2026-08-01T10:02:00Z",
            "message": {"id": "m-2", "usage": {"input_tokens": 5, "output_tokens": 1}},
        }) + "\n"
        jsonl_file.write_text(first, encoding="utf-8")
        cursor, status = ClaudeCodeCollector(config={"claude_config_dir": str(self.claude_dir)}).create_session_cursor(
            sid,
            baseline=[{"config_dir_name": "custom", "session_id": sid, "file_size": len(first.encode("utf-8"))}],
        )
        jsonl_file.write_text(first + replay + new, encoding="utf-8")

        self.assertEqual(status, "AVAILABLE")
        res = ClaudeCodeCollector().parse_transcript_line_by_line(jsonl_file, cursor_before=cursor)
        self.assertEqual(res["input_tokens"], 5)
        self.assertEqual(res["output_tokens"], 1)

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
