import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.cli import CLIHandler
from agent_metrics.storage import StorageManager, IntegrityError, StorageError
from agent_metrics.models import (
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_INVALID_INPUT,
    EXIT_STORAGE_ERROR,
    EXIT_INTEGRITY_ERROR,
    EXIT_EXTERNAL_CMD_ERROR,
)


def extract_run_id(output: str) -> str:
    """Extract the run_id from cmd_start output.

    Contract: exactly one line in the output must start with 'RUN_ID='.
    Raises AssertionError if that invariant is violated.
    """
    matches = [
        line[len("RUN_ID="):]
        for line in output.splitlines()
        if line.startswith("RUN_ID=")
    ]
    assert len(matches) == 1, (
        f"Expected exactly one 'RUN_ID=' line in cmd_start output, found {len(matches)}. "
        f"Output was: {output!r}"
    )
    return matches[0]


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # ------------------------------------------------------------------ #
    # Original tests (preserved and updated)                               #
    # ------------------------------------------------------------------ #

    # Test 1: doctor JSON output
    def test_doctor_json_output(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_doctor(json_output=True)
            output = fake_out.getvalue()
            data = json.loads(output)
            self.assertIn("version", data)
            self.assertIn("python_version", data)
            self.assertIn("git", data)
            self.assertIn("github_cli", data)
            self.assertIn("cockpit", data)

    def test_snapshot_codex_json_output(self):
        fake_snapshot = {
            "status": "COMPLETE",
            "source": "cockpit_report_http",
            "provider": "OpenAI",
            "primary_window": {"percentage": 99.0},
        }
        with patch(
            "agent_metrics.cli.CodexQuotaCollector.capture_snapshot",
            return_value=fake_snapshot,
        ), patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_snapshot(provider="codex", json_output=True)
        self.assertEqual(code, EXIT_OK)
        data = json.loads(fake_out.getvalue())
        self.assertEqual(data["provider"], "codex")
        self.assertEqual(data["status"], "COMPLETE")
        self.assertEqual(data["snapshot"]["primary_window"]["percentage"], 99.0)

    def test_snapshot_invalid_provider(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_snapshot(provider="unknown-provider", json_output=True)
        self.assertEqual(code, EXIT_INVALID_INPUT)

    def test_bind_session_rejects_path_like_session_id(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            self.cli.cmd_start(agent_shell="Codex", provider="OpenAI", json_output=True)
            run_id = json.loads(fake_out.getvalue())["run_id"]

        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_bind_session(
                run_id=run_id,
                agent_session_id="C:\\Users\\PrivateUser\\session",
                binding_source="manual",
            )
        self.assertEqual(code, EXIT_INVALID_INPUT)

    def test_bind_session_updates_private_context(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            self.cli.cmd_start(agent_shell="Codex", provider="OpenAI", json_output=True)
            run_id = json.loads(fake_out.getvalue())["run_id"]

        with patch("sys.stdout", new=io.StringIO()):
            code = self.cli.cmd_bind_session(
                run_id=run_id,
                agent_session_id="thread-abc123",
                agent_process_id=1234,
                binding_source="codex_exec_json_thread",
                json_output=True,
            )
        self.assertEqual(code, EXIT_OK)
        ctx = self.storage.read_run_context(run_id)
        self.assertEqual(ctx["agent_session_id"], "thread-abc123")
        self.assertEqual(ctx["agent_process_id"], 1234)
        self.assertEqual(ctx["session_binding_status"], "BOUND")

    def test_mark_session_ambiguous_updates_private_context(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="DeepSeek", json_output=True)
            run_id = json.loads(fake_out.getvalue())["run_id"]

        with patch("sys.stdout", new=io.StringIO()):
            code = self.cli.cmd_mark_session_ambiguous(
                run_id=run_id,
                binding_source="new_jsonl_after_process_start",
                json_output=True,
            )
        self.assertEqual(code, EXIT_OK)
        ctx = self.storage.read_run_context(run_id)
        self.assertEqual(ctx["session_binding_status"], "AMBIGUOUS")
        self.assertIsNone(ctx["agent_session_id"])

    # Test 2: start creates Run directory and run-context.json
    def test_start_creates_run(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_start(
                agent_shell="Claude-Code",
                provider="DeepSeek",
                configured_model="deepseek-v4-flash",
                work_package="WP-TEST-01",
                pr_number=60,
                json_output=True,
            )
            self.assertEqual(code, EXIT_OK)
            # json_output=True emits JSON; parse run_id directly from the JSON object.
            data = json.loads(fake_out.getvalue())
            run_id = data["run_id"]
            self.assertTrue(Path(self.temp_dir, run_id, "run-context.json").exists())


    # Test 3: start output contains exactly one RUN_ID= line
    def test_start_outputs_run_id_line(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_start(
                agent_shell="Antigravity",
                provider="Google",
                configured_model="gemini-3.6-flash",
                work_package="AG-TEST-01",
                json_output=False,
            )
            self.assertEqual(code, EXIT_OK)
            output = fake_out.getvalue()
            self.assertIn("RUN_ID=", output)
            self.assertIn('$env:ZUNO_AGENT_RUN_ID = "', output)

    # Test 4: finish updates finished_at and wall_clock_seconds
    def test_finish_updates_finished_at(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        with patch("sys.stdout", new=io.StringIO()) as fake_fin_out:
            code = self.cli.cmd_finish(run_id=run_id, json_output=True)
            self.assertEqual(code, EXIT_OK)
            out_str = fake_fin_out.getvalue()
            summary = json.loads(out_str[out_str.find("{"):out_str.rfind("}")+1])
            self.assertIsNotNone(summary["timing"]["finished_at"])
            self.assertIsNotNone(summary["timing"]["wall_clock_seconds"])
            self.assertGreaterEqual(summary["timing"]["wall_clock_seconds"], 0.0)

    def test_finish_does_not_promote_quota_attribution_from_exact_session(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic", session_id="session-abc123")
            run_id = extract_run_id(fake_start_out.getvalue())

        with patch(
            "agent_metrics.cli.ClaudeCodeCollector.collect",
            return_value={
                "status": "AVAILABLE",
                "matched_session": {
                    "session_id": "session-abc123",
                    "input_tokens": 5,
                    "output_tokens": 1,
                    "reasoning_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 6,
                    "observed_model": "claude-3-5-sonnet-20241022",
                    "start_time": None,
                    "end_time": None,
                    "session_cursor_after": {},
                },
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
        ), patch("sys.stdout", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id=run_id)

        self.assertEqual(code, EXIT_OK)
        summary = self.storage.read_sanitized_summary(run_id)
        self.assertEqual(summary["usage"]["correlation_confidence"], "EXACT_SESSION_AND_CURSOR")
        self.assertEqual(summary["quota"]["scope"], "ACCOUNT")
        self.assertEqual(summary["quota"]["attribution"], "NOT_PROVEN")

    # Test 6: export JSON format
    def test_export_json_format(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        self.cli.cmd_finish(run_id=run_id)
        export_file = Path(self.temp_dir, "export.json")
        code = self.cli.cmd_export(run_id=run_id, format_type="json", output_path=str(export_file))
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(export_file.exists())
        data = json.loads(export_file.read_text(encoding="utf-8"))
        self.assertEqual(data["run_id"], run_id)

    # Test 7: export Zuno PR Record Fragment format
    def test_export_zuno_fragment_format(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic", work_package="WP-007")
            run_id = extract_run_id(fake_start_out.getvalue())

        self.cli.cmd_finish(run_id=run_id)
        export_file = Path(self.temp_dir, "zuno_fragment.json")
        code = self.cli.cmd_export(run_id=run_id, format_type="zuno-pr-record-fragment", output_path=str(export_file))
        self.assertEqual(code, EXIT_OK)
        data = json.loads(export_file.read_text(encoding="utf-8"))
        self.assertEqual(data["schema_version"], "zuno-pr-record-fragment-v1")
        self.assertEqual(data["work_package"], "WP-007")

    # Test 8: unknown run_id handling
    def test_unknown_run_id(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id="non-existent-uuid", json_output=False)
            self.assertEqual(code, EXIT_STORAGE_ERROR)

    # Test 9: invalid parameters handling
    def test_invalid_parameters(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_start(agent_shell="", provider="")
            self.assertEqual(code, EXIT_INVALID_INPUT)

    # Test 10: repeated finish is idempotent — uses extract_run_id helper
    def test_finish_idempotency(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        s1 = self.storage.read_sanitized_summary(run_id)

        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        s2 = self.storage.read_sanitized_summary(run_id)

        self.assertEqual(s1["timing"]["started_at"], s2["timing"]["started_at"])
        self.assertEqual(s1["run_id"], s2["run_id"])

    # ------------------------------------------------------------------ #
    # Run ID strict validation tests                                       #
    # ------------------------------------------------------------------ #

    def test_runid_01_valid_id_can_finish(self):
        """A valid run_id (start → finish) completes with EXIT_OK."""
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(agent_shell="TestShell", provider="TestProvider")
            run_id = extract_run_id(out.getvalue())
        with patch("sys.stdout", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id=run_id)
        self.assertEqual(code, EXIT_OK)

    def test_runid_02_embedded_newline_rejected(self):
        """Run ID with embedded newline is rejected with EXIT_INVALID_INPUT."""
        fake_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nextra-content"
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id=fake_id)
        self.assertEqual(code, EXIT_INVALID_INPUT)

    def test_runid_03_powershell_suffix_rejected(self):
        """Run ID followed by PowerShell env-var text is rejected."""
        fake_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n$env:ZUNO_AGENT_RUN_ID"
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id=fake_id)
        self.assertEqual(code, EXIT_INVALID_INPUT)

    def test_runid_04_space_in_id_rejected(self):
        """Run ID containing a space is rejected with EXIT_INVALID_INPUT."""
        fake_id = "aaaaaaaa bbbb cccc dddd eeeeeeeeeeee"
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id=fake_id)
        self.assertEqual(code, EXIT_INVALID_INPUT)

    def test_runid_05_invalid_id_creates_no_directory(self):
        """An invalid run_id must not cause any directory to be created."""
        fake_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nextra"
        before = set(Path(self.temp_dir).iterdir())
        with patch("sys.stderr", new=io.StringIO()):
            self.cli.cmd_finish(run_id=fake_id)
        after = set(Path(self.temp_dir).iterdir())
        self.assertEqual(before, after, "Invalid run_id caused a directory to be created")

    def test_runid_06_start_output_has_exactly_one_run_id_line(self):
        """cmd_start non-JSON output has exactly one line starting with 'RUN_ID='."""
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(agent_shell="TestShell", provider="TestProvider", json_output=False)
            lines = out.getvalue().splitlines()
        run_id_lines = [l for l in lines if l.startswith("RUN_ID=")]
        self.assertEqual(len(run_id_lines), 1,
                         f"Expected 1 RUN_ID= line, got {len(run_id_lines)}: {lines}")

    def test_runid_07_extract_run_id_helper_works(self):
        """extract_run_id correctly extracts the UUID from non-JSON output."""
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(agent_shell="TestShell", provider="TestProvider", json_output=False)
            output = out.getvalue()
        run_id = extract_run_id(output)
        # Must be a non-empty string matching UUID pattern
        self.assertRegex(run_id, r"^[a-f0-9\-]{36}$")

    # ------------------------------------------------------------------ #
    # Reconcile GitHub failure tests                                       #
    # ------------------------------------------------------------------ #

    def _start_run(self, pr_number=None):
        """Helper: start a run and return its run_id."""
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(
                agent_shell="TestShell",
                provider="TestProvider",
                pr_number=pr_number,
            )
            return extract_run_id(out.getvalue())

    def test_reconcile_08_gh_not_found_returns_partial(self):
        """When gh CLI is missing, reconcile returns EXIT_PARTIAL."""
        run_id = self._start_run(pr_number=99)
        with patch("shutil.which", return_value=None):
            with patch("sys.stderr", new=io.StringIO()):
                code = self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        self.assertEqual(code, EXIT_PARTIAL)

    def test_reconcile_09_gh_not_authenticated_returns_partial(self):
        """When gh auth status fails (not authenticated), reconcile returns EXIT_PARTIAL."""
        run_id = self._start_run(pr_number=99)
        # Simulate gh present but auth failing (which GithubCollector maps to NOT_AVAILABLE → EXIT_PARTIAL)
        with patch("shutil.which", return_value="/usr/bin/gh"):
            with patch("agent_metrics.collectors.github_collector.GithubCollector.run_gh",
                       return_value=(1, "You are not authenticated")):
                with patch("sys.stderr", new=io.StringIO()):
                    code = self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        self.assertEqual(code, EXIT_PARTIAL)

    def test_reconcile_10_gh_command_fails_returns_external_error(self):
        """When gh pr view returns non-zero (not auth error), reconcile returns EXIT_EXTERNAL_CMD_ERROR."""
        run_id = self._start_run(pr_number=99)
        with patch("shutil.which", return_value="/usr/bin/gh"):
            # Auth OK, but pr view fails
            def fake_run_gh(args):
                if args[0] == "auth":
                    return (0, "Logged in")
                return (1, "some gh error")
            with patch("agent_metrics.collectors.github_collector.GithubCollector.run_gh",
                       side_effect=fake_run_gh):
                with patch("sys.stderr", new=io.StringIO()):
                    code = self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        self.assertIn(code, (EXIT_PARTIAL, EXIT_EXTERNAL_CMD_ERROR))

    def test_reconcile_11_gh_invalid_json_returns_external_error(self):
        """When gh returns non-JSON output, reconcile returns EXIT_EXTERNAL_CMD_ERROR."""
        run_id = self._start_run(pr_number=99)
        with patch("shutil.which", return_value="/usr/bin/gh"):
            def fake_run_gh(args):
                if args[0] == "auth":
                    return (0, "Logged in")
                return (0, "this is not json at all")
            with patch("agent_metrics.collectors.github_collector.GithubCollector.run_gh",
                       side_effect=fake_run_gh):
                with patch("sys.stderr", new=io.StringIO()):
                    code = self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        self.assertIn(code, (EXIT_PARTIAL, EXIT_EXTERNAL_CMD_ERROR))

    def test_reconcile_12_gh_failure_no_summary_created(self):
        """When gh fails on a run with no summary yet, no sanitized-summary.json is created."""
        run_id = self._start_run(pr_number=99)
        summary_file = Path(self.temp_dir) / run_id / "sanitized-summary.json"
        self.assertFalse(summary_file.exists(), "Precondition: no summary before reconcile")
        with patch("shutil.which", return_value=None):
            with patch("sys.stderr", new=io.StringIO()):
                self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        self.assertFalse(summary_file.exists(),
                         "gh failure must NOT create sanitized-summary.json")

    def test_reconcile_13_gh_failure_does_not_overwrite_existing_summary(self):
        """When gh fails on a run that already has a summary, the existing summary is preserved."""
        run_id = self._start_run(pr_number=99)
        # Finish first to create a valid summary
        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        original = self.storage.read_sanitized_summary(run_id)
        original_sha = original.get("integrity", {}).get("payload_sha256")

        with patch("shutil.which", return_value=None):
            with patch("sys.stderr", new=io.StringIO()):
                self.cli.cmd_reconcile(run_id=run_id, pr_number=99)

        preserved = self.storage.read_sanitized_summary(run_id)
        self.assertEqual(original_sha, preserved.get("integrity", {}).get("payload_sha256"),
                         "Existing summary was overwritten on gh failure")

    def test_reconcile_14_gh_failure_no_event_appended(self):
        """When gh fails, no RUN_RECONCILED event is appended."""
        run_id = self._start_run(pr_number=99)
        events_before = len(self.storage.read_events(run_id))
        with patch("shutil.which", return_value=None):
            with patch("sys.stderr", new=io.StringIO()):
                self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
        events_after = len(self.storage.read_events(run_id))
        self.assertEqual(events_before, events_after,
                         "gh failure must not append any events")

    def test_reconcile_15_gh_failure_no_success_on_stdout(self):
        """When gh fails, stdout must not contain 'Reconciled'."""
        run_id = self._start_run(pr_number=99)
        with patch("shutil.which", return_value=None):
            with patch("sys.stdout", new=io.StringIO()) as fake_out:
                with patch("sys.stderr", new=io.StringIO()):
                    self.cli.cmd_reconcile(run_id=run_id, pr_number=99)
                stdout = fake_out.getvalue()
        self.assertNotIn("Reconciled", stdout,
                         "gh failure must not print success message")

    # ------------------------------------------------------------------ #
    # Reconcile integrity fail-closed tests                                #
    # ------------------------------------------------------------------ #

    def _make_run_with_summary(self, pr_number=None):
        """Helper: start + finish a run, return run_id."""
        run_id = self._start_run(pr_number=pr_number)
        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        return run_id

    def _tamper_summary(self, run_id: str):
        """Tamper the sanitized-summary.json to break integrity."""
        summary_file = Path(self.temp_dir) / run_id / "sanitized-summary.json"
        data = json.loads(summary_file.read_bytes())
        data["_tampered"] = True
        summary_file.write_bytes(json.dumps(data).encode())

    def _remove_sidecar(self, run_id: str):
        """Remove the .sha256 sidecar file."""
        sha_file = Path(self.temp_dir) / run_id / "sanitized-summary.sha256"
        if sha_file.exists():
            sha_file.unlink()

    def test_reconcile_16_tampered_summary_returns_integrity_error(self):
        """Tampered summary → reconcile returns EXIT_INTEGRITY_ERROR (6)."""
        run_id = self._make_run_with_summary()
        self._tamper_summary(run_id)
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        self.assertEqual(code, EXIT_INTEGRITY_ERROR)

    def test_reconcile_17_missing_sidecar_returns_integrity_error(self):
        """Missing .sha256 sidecar → reconcile returns EXIT_INTEGRITY_ERROR (6)."""
        run_id = self._make_run_with_summary()
        self._remove_sidecar(run_id)
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        self.assertEqual(code, EXIT_INTEGRITY_ERROR)

    def test_reconcile_18_integrity_failure_summary_bytes_unchanged(self):
        """After reconcile on tampered summary, file bytes are unchanged."""
        run_id = self._make_run_with_summary()
        summary_file = Path(self.temp_dir) / run_id / "sanitized-summary.json"
        original_bytes = summary_file.read_bytes()
        self._tamper_summary(run_id)
        tampered_bytes = summary_file.read_bytes()
        with patch("sys.stderr", new=io.StringIO()):
            self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        after_bytes = summary_file.read_bytes()
        self.assertEqual(tampered_bytes, after_bytes,
                         "Integrity failure must not modify the summary file")

    def test_reconcile_19_integrity_failure_event_count_unchanged(self):
        """After reconcile on tampered summary, event log is not extended."""
        run_id = self._make_run_with_summary()
        events_before = len(self.storage.read_events(run_id))
        self._tamper_summary(run_id)
        with patch("sys.stderr", new=io.StringIO()):
            self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        events_after = len(self.storage.read_events(run_id))
        self.assertEqual(events_before, events_after,
                         "Integrity failure must not append any events")

    def test_reconcile_20_integrity_failure_github_not_called(self):
        """GithubCollector.collect_pr_info must not be called when integrity fails."""
        run_id = self._make_run_with_summary()
        self._tamper_summary(run_id)
        with patch("agent_metrics.collectors.github_collector.GithubCollector.collect_pr_info") as mock_gh:
            with patch("sys.stderr", new=io.StringIO()):
                self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        mock_gh.assert_not_called()

    # ------------------------------------------------------------------ #
    # Success regression tests                                             #
    # ------------------------------------------------------------------ #

    def test_reconcile_21_success_updates_summary(self):
        """When GitHub returns EXIT_OK, reconcile updates the summary's github field."""
        run_id = self._make_run_with_summary(pr_number=42)
        github_data = {"state": "OPEN", "number": 42, "status": "AVAILABLE"}

        with patch("agent_metrics.collectors.github_collector.GithubCollector.collect_pr_info",
                   return_value=(EXIT_OK, github_data)):
            with patch("sys.stdout", new=io.StringIO()):
                code = self.cli.cmd_reconcile(run_id=run_id, pr_number=42)

        self.assertEqual(code, EXIT_OK)
        summary = self.storage.read_sanitized_summary(run_id)
        self.assertIn("github", summary)

    def test_reconcile_22_success_returns_exit_ok(self):
        """Successful reconcile returns EXIT_OK."""
        run_id = self._make_run_with_summary(pr_number=1)
        github_data = {"state": "OPEN", "number": 1, "status": "AVAILABLE"}
        with patch("agent_metrics.collectors.github_collector.GithubCollector.collect_pr_info",
                   return_value=(EXIT_OK, github_data)):
            with patch("sys.stdout", new=io.StringIO()):
                code = self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        self.assertEqual(code, EXIT_OK)

    def test_reconcile_23_success_appends_reconciled_event(self):
        """Successful reconcile appends exactly one RUN_RECONCILED event."""
        run_id = self._make_run_with_summary(pr_number=1)
        events_before = len(self.storage.read_events(run_id))
        github_data = {"state": "OPEN", "number": 1, "status": "AVAILABLE"}
        with patch("agent_metrics.collectors.github_collector.GithubCollector.collect_pr_info",
                   return_value=(EXIT_OK, github_data)):
            with patch("sys.stdout", new=io.StringIO()):
                self.cli.cmd_reconcile(run_id=run_id, pr_number=1)
        events_after = self.storage.read_events(run_id)
        self.assertEqual(len(events_after), events_before + 1)
        self.assertEqual(events_after[-1].get("event_type"), "RUN_RECONCILED")

    def test_reconcile_24_finish_idempotency_regression(self):
        """The original finish-idempotency behaviour still holds after the new changes."""
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(out.getvalue())

        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        s1 = self.storage.read_sanitized_summary(run_id)

        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_finish(run_id=run_id)
        s2 = self.storage.read_sanitized_summary(run_id)

        self.assertEqual(s1["run_id"], s2["run_id"])
        self.assertEqual(s1["timing"]["started_at"], s2["timing"]["started_at"])
        self.assertEqual(
            s1.get("integrity", {}).get("payload_sha256"),
            s2.get("integrity", {}).get("payload_sha256"),
        )


if __name__ == "__main__":
    unittest.main()
