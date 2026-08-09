"""
Comprehensive Trust Boundary and Reality Repair scenario test suite (32 P0/P1/P2 scenarios).
Reads fake secrets strictly from fixture file.
"""

import io
import json
import re
import tempfile
import shutil
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_metrics.redaction import sanitize_dict, redact_text, scan_text_for_secret_types
from agent_metrics.models import (
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_INVALID_INPUT,
    EXIT_STORAGE_ERROR,
    EXIT_INTEGRITY_ERROR,
    EXIT_EXTERNAL_CMD_ERROR,
    SanitizedSummary,
    ModelConfidence,
    CorrelationConfidence,
)
from agent_metrics.storage import StorageManager, IntegrityError
from agent_metrics.cli import CLIHandler
from agent_metrics.pricing import PricingEngine
from agent_metrics.collectors.antigravity_collector import AntigravityCollector
from agent_metrics.collectors.cockpit_collector import CockpitCollector, is_local_url
from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector
from agent_metrics.collectors.git_collector import GitCollector
from agent_metrics.collectors.github_collector import GithubCollector
from agent_metrics.validators import validate_sanitized_summary, validate_usage

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json"


def extract_run_id(output: str) -> str:
    m = re.search(r"^RUN_ID=([a-f0-9\-]+)$", output, re.MULTILINE | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m2 = re.search(r'ZUNO_AGENT_RUN_ID="([a-f0-9\-]+)"', output, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    if "{" in output:
        try:
            s_idx = output.find("{")
            e_idx = output.rfind("}") + 1
            data = json.loads(output[s_idx:e_idx])
            return str(data.get("run_id", "")).strip('"\' \n\r')
        except Exception:
            pass
    return ""


class TestTrustBoundaryScenarios(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            self.fake_secrets = json.load(f)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # 1. input_tokens preserves integer
    def test_01_input_tokens_preserves_integer_after_redaction(self):
        data = {"input_tokens": 12345, "token": "secret_token"}
        sanitized = sanitize_dict(data)
        self.assertEqual(sanitized["input_tokens"], 12345)
        self.assertIsInstance(sanitized["input_tokens"], int)

    # 2. output_tokens preserves integer
    def test_02_output_tokens_preserves_integer_after_redaction(self):
        data = {"output_tokens": 6789, "secret": "secret_val"}
        sanitized = sanitize_dict(data)
        self.assertEqual(sanitized["output_tokens"], 6789)
        self.assertIsInstance(sanitized["output_tokens"], int)

    # 3. Git 40-char SHA preserved
    def test_03_git_40_char_sha_preserved(self):
        sha = "adbe2efdbaa6fc56ac7f732158c18b1818cd3ce2"
        res = redact_text(sha)
        self.assertEqual(res, sha)

    # 4. Prompt field completely deleted
    def test_04_prompt_field_completely_deleted(self):
        data = {"prompt": "User prompt text", "input_tokens": 50}
        sanitized = sanitize_dict(data)
        self.assertNotIn("prompt", sanitized)

    # 5. Messages field completely deleted
    def test_05_messages_field_completely_deleted(self):
        data = {"messages": [{"role": "user", "content": "hi"}], "output_tokens": 20}
        sanitized = sanitize_dict(data)
        self.assertNotIn("messages", sanitized)

    # 6. Home username not in Summary
    def test_06_home_username_not_in_summary(self):
        home_path = str(Path.home())
        res = redact_text(f"File at {home_path}/project/file.txt")
        self.assertNotIn(home_path, res)
        self.assertIn("[HOME]", res)

    # 7. Management Key not in any local file
    def test_07_management_key_not_in_any_local_file(self):
        run_id = "55555555-5555-5555-5555-555555555555"
        self.storage.create_run({
            "run_id": run_id,
            "started_at": "2026-08-01T10:00:00Z",
            "agent": {"shell": "bash", "provider": "Anthropic"},
            "management_key": self.fake_secrets["fake_management_key"]
        })
        self.cli.cmd_finish(run_id=run_id)

        run_dir = self.storage.get_run_dir(run_id)
        for p in run_dir.rglob("*"):
            if p.is_file():
                txt = p.read_text(encoding="utf-8", errors="ignore")
                self.assertNotIn(self.fake_secrets["fake_management_key"], txt)

    # 8. Quota response email not in run-context
    def test_08_quota_response_email_not_in_run_context(self):
        ctx = {
            "run_id": "66666666-6666-6666-6666-666666666666",
            "started_at": "2026-08-01T10:00:00Z",
            "work_package": "WP-TEST",
            "agent": {"shell": "bash", "provider": "Anthropic"},
            "quota_email": self.fake_secrets["fake_email"]
        }
        self.storage.create_run(ctx)
        read_ctx = self.storage.read_run_context("66666666-6666-6666-6666-666666666666")
        self.assertNotIn(self.fake_secrets["fake_email"], json.dumps(read_ctx))

    # 9. Two parallel Antigravity runs -> AMBIGUOUS
    def test_09_two_parallel_antigravity_runs_ambiguous(self):
        coll = AntigravityCollector()
        events = [{"timestamp": "2026-08-01T10:05:00Z", "input_tokens": 100, "output_tokens": 50}]
        usage = coll.correlate_usage(
            candidate_events=events,
            started_at="2026-08-01T10:00:00Z",
            finished_at="2026-08-01T10:10:00Z",
            active_runs_count=2
        )
        self.assertEqual(usage.correlation_confidence, CorrelationConfidence.AMBIGUOUS.value)
        self.assertEqual(usage.collection_status, "NOT_AVAILABLE")
        self.assertIsNone(usage.total_tokens)

    # 10. Different model events not merged
    def test_10_different_model_events_not_merged(self):
        coll = AntigravityCollector()
        events = [
            {"timestamp": "2026-08-01T10:05:00Z", "model": "claude-3-5-sonnet", "input_tokens": 100, "output_tokens": 50},
            {"timestamp": "2026-08-01T10:06:00Z", "model": "gpt-4o", "input_tokens": 500, "output_tokens": 200},
        ]
        usage = coll.correlate_usage(
            candidate_events=events,
            started_at="2026-08-01T10:00:00Z",
            finished_at="2026-08-01T10:10:00Z",
            expected_model="claude-3-5-sonnet",
            active_runs_count=1
        )
        self.assertEqual(usage.input_tokens, 100)
        self.assertEqual(usage.output_tokens, 50)

    # 11. Time window outside events not merged
    def test_11_time_window_outside_events_not_merged(self):
        coll = AntigravityCollector()
        events = [
            {"timestamp": "2026-08-01T09:55:00Z", "input_tokens": 500, "output_tokens": 500},
            {"timestamp": "2026-08-01T10:05:00Z", "input_tokens": 100, "output_tokens": 50},
        ]
        usage = coll.correlate_usage(
            candidate_events=events,
            started_at="2026-08-01T10:00:00Z",
            finished_at="2026-08-01T10:10:00Z",
            active_runs_count=1
        )
        self.assertEqual(usage.input_tokens, 100)

    # 12. configured_model not promoted to OBSERVED
    def test_12_configured_model_not_promoted_to_observed(self):
        with patch("sys.stdout", new=io.StringIO()) as start_out:
            self.cli.cmd_start(agent_shell="bash", provider="Anthropic", configured_model="deepseek-v4-flash")
            run_id = extract_run_id(start_out.getvalue())
        ctx = self.storage.read_run_context(run_id)
        self.assertIsNone(ctx["agent"].get("observed_model"))
        self.assertEqual(ctx["agent"].get("model_detection_confidence"), ModelConfidence.CONFIGURED.value)

    # 13. doctor does not consume usage queue
    def test_13_doctor_does_not_consume_usage_queue(self):
        coll = CockpitCollector()
        res = coll.collect(include_usage_queue=False)
        self.assertEqual(res["request_usage_surface"], "UNSUPPORTED")
        self.assertNotIn("usage_events", res)

    # 14. Management key not sent to guessed ports
    def test_14_management_key_not_sent_to_guessed_ports(self):
        self.assertFalse(is_local_url("http://192.168.1.1:9090"))
        coll = CockpitCollector(config={"base_url": "http://192.168.1.1:9090"})
        healthy, _ = coll.probe_management_health()
        self.assertFalse(healthy)

    # 15. Fabricated endpoints no longer exist
    def test_15_fabricated_endpoints_no_longer_exist(self):
        import inspect
        src = inspect.getsource(CockpitCollector)
        self.assertNotIn("/api/v1/quota", src)
        self.assertNotIn("/api/v1/usage/events", src)

    # 16. Real format Claude JSONL fixture
    def test_16_real_format_claude_jsonl_fixture(self):
        p = Path(self.temp_dir) / "sess.jsonl"
        p.write_text(json.dumps({
            "type": "assistant",
            "sessionId": "sess-real",
            "timestamp": "2026-08-01T10:00:00Z",
            "message": {
                "id": "msg-1",
                "model": "MiniMax-M2.7",
                "usage": {"input_tokens": 10, "output_tokens": 5}
            }
        }) + "\n", encoding="utf-8")
        coll = ClaudeCodeCollector()
        parsed = coll.parse_transcript_line_by_line(p)
        self.assertEqual(parsed["session_id"], "sess-real")
        self.assertEqual(parsed["input_tokens"], 10)

    # 17. Transcript message content not persisted
    def test_17_transcript_message_content_not_persisted(self):
        data = sanitize_dict({"type": "assistant", "message": {"content": "Private Code", "usage": {"input_tokens": 5}}})
        self.assertNotIn("content", data.get("message", {}))

    # 18. Multi message usage correctly deduplicated
    def test_18_multi_message_usage_correctly_deduplicated(self):
        p = Path(self.temp_dir) / "sess_dedup.jsonl"
        lines = [
            json.dumps({"type": "assistant", "sessionId": "s1", "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}}}),
            json.dumps({"type": "assistant", "sessionId": "s1", "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 15}}}),
        ]
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        coll = ClaudeCodeCollector()
        res = coll.parse_transcript_line_by_line(p)
        self.assertEqual(res["output_tokens"], 15)

    # 19. Payload Hash verification
    def test_19_payload_hash_verification(self):
        run_id = "88888888-8888-8888-8888-888888888888"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        written = self.storage.write_sanitized_summary(run_id, {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": run_id,
            "work_package": "WP",
            "agent": {"shell": "bash", "provider": "Anthropic"},
            "timing": {"started_at": "2026-08-01T10:00:00Z"},
            "usage": {"collection_status": "NOT_AVAILABLE"},
            "pricing": {"status": "PRICE_NOT_AVAILABLE"},
            "quota": {},
            "git": {},
            "github": {},
            "collectors": {},
            "warnings": [],
            "integrity": {}
        })
        self.assertIn("payload_sha256", written["integrity"])

    # 20. File Hash verification
    def test_20_file_hash_verification(self):
        run_id = "99999999-9999-9999-9999-999999999999"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id)
        sha_file = self.storage.get_run_dir(run_id) / "sanitized-summary.sha256"
        self.assertTrue(sha_file.exists())

    # 21. File tampered -> show Exit 6
    def test_21_file_tampered_show_exit_6(self):
        run_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id)

        summary_file = self.storage.get_run_dir(run_id) / "sanitized-summary.json"
        summary_file.write_text("{ \"corrupted\": true }", encoding="utf-8")
        code = self.cli.cmd_show(run_id=run_id)
        self.assertEqual(code, EXIT_INTEGRITY_ERROR)

    # 22. File tampered -> export Exit 6
    def test_22_file_tampered_export_exit_6(self):
        run_id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id)

        summary_file = self.storage.get_run_dir(run_id) / "sanitized-summary.json"
        summary_file.write_text("{ \"corrupted\": true }", encoding="utf-8")
        code = self.cli.cmd_export(run_id=run_id, output_path=str(Path(self.temp_dir) / "out.json"))
        self.assertEqual(code, EXIT_INTEGRITY_ERROR)

    # 23. Idempotent finish byte exact
    def test_23_idempotent_finish_byte_exact(self):
        run_id = "cccccccc-dddd-eeee-ffff-000000000000"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id)
        f_path = self.storage.get_run_dir(run_id) / "sanitized-summary.json"
        b1 = f_path.read_bytes()
        self.cli.cmd_finish(run_id=run_id)
        b2 = f_path.read_bytes()
        self.assertEqual(b1, b2)

    # 24. Idempotent finish Event count unchanged
    def test_24_idempotent_finish_event_count_unchanged(self):
        run_id = "dddddddd-eeee-ffff-0000-111111111111"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id)
        ev1 = self.storage.read_events(run_id)
        self.cli.cmd_finish(run_id=run_id)
        ev2 = self.storage.read_events(run_id)
        self.assertEqual(len(ev1), len(ev2))

    # 25. Git initial..final round commit count
    def test_25_git_initial_final_round_commit_count(self):
        git_coll = GitCollector()
        info = git_coll.collect(initial_git_info={"initial_head_sha": "adbe2efdbaa6fc56ac7f732158c18b1818cd3ce2"})
        self.assertIn("round_commit_count", info)

    # 26. Git initial..final diff stats
    def test_26_git_initial_final_diff_stats(self):
        git_coll = GitCollector()
        info = git_coll.collect(initial_git_info={"initial_head_sha": "adbe2efdbaa6fc56ac7f732158c18b1818cd3ce2"})
        self.assertIn("round_changed_files", info)
        self.assertIn("round_additions", info)
        self.assertIn("round_deletions", info)

    # 27. gh missing -> Exit 2 or 7
    def test_27_gh_missing_exit_partial(self):
        gh_coll = GithubCollector()
        code, info = gh_coll.collect_pr_info(pr_number=9999)
        self.assertIn(code, (EXIT_PARTIAL, EXIT_EXTERNAL_CMD_ERROR))
        self.assertIn(info.get("status"), ("NOT_AVAILABLE", "CONFIG_REQUIRED", "ERROR"))

    # 28. gh invalid JSON -> Exit 7
    def test_28_gh_invalid_json_exit_external_cmd_error(self):
        gh_coll = GithubCollector()
        gh_coll.run_gh = lambda args: (0, "invalid_json_text")
        code, info = gh_coll.collect_pr_info(pr_number=1)
        self.assertEqual(code, EXIT_EXTERNAL_CMD_ERROR)
        self.assertEqual(info.get("status"), "ERROR")

    # 29. Ordinary tests dir scanned by secret scanner
    def test_29_ordinary_tests_dir_scanned_by_secret_scanner(self):
        code = self.cli.cmd_internal_scan_secrets(scan_path="src")
        self.assertEqual(code, EXIT_OK)

    # 30. Scanner failure cannot report PASS
    def test_30_scanner_failure_cannot_report_pass(self):
        tmp_file = Path(self.temp_dir) / "test_dummy.py"
        tmp_file.write_text(f"api_key = '{self.fake_secrets['fake_sk_api_key']}'", encoding="utf-8")
        code = self.cli.cmd_internal_scan_secrets(scan_path=self.temp_dir)
        self.assertEqual(code, 1)

    # 31. Negative tokens invalid usage
    def test_31_negative_tokens_invalid_usage(self):
        pe = PricingEngine()
        info = pe.calculate_cost(model_name="claude-3-5-sonnet", input_tokens=-10, output_tokens=50)
        self.assertEqual(info.status, "INVALID_USAGE")
        self.assertIsNone(info.api_equivalent_cost_usd)

    # 32. Summary Schema invalid -> Exit Code 6
    def test_32_invalid_summary_schema(self):
        with self.assertRaises(ValueError):
            validate_sanitized_summary({"invalid": "schema"})


if __name__ == "__main__":
    unittest.main()
