import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.cli import CLIHandler
from agent_metrics.models import EXIT_INVALID_INPUT, EXIT_OK
from agent_metrics.pr_aggregate import build_pr_aggregate
from agent_metrics.storage import StorageManager


def _summary(run_id, pr_number, shell, provider, usage, pricing=None, timing=None, provider_quota=None, repository="ProfessorZhi/agent-metrics-collector"):
    data = {
        "schema_version": 1,
        "collector_version": "0.1.0",
        "run_id": run_id,
        "work_package": "PR-AGG",
        "pr_number": pr_number,
        "repository": repository,
        "agent": {"shell": shell, "provider": provider},
        "timing": {
            "started_at": "2026-08-02T00:00:00+00:00",
            "finished_at": "2026-08-02T00:10:00+00:00",
            "wall_clock_seconds": 600.0,
            "agent_process_seconds": None,
            "model_event_span_seconds": None,
        },
        "usage": usage,
        "pricing": pricing or {
            "status": "USAGE_NOT_AVAILABLE",
            "api_equivalent_cost_usd": None,
            "actual_billed_cost_usd": None,
        },
        "quota": {},
        "git": {},
        "github": {},
        "collectors": {},
        "warnings": [],
        "integrity": {},
    }
    if timing:
        data["timing"].update(timing)
    if provider_quota:
        data["provider_quota"] = provider_quota
    return data


class TestPrAggregate(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _write_summary(self, data):
        self.storage.get_run_dir(data["run_id"]).mkdir(parents=True, exist_ok=True)
        self.storage.write_sanitized_summary(data["run_id"], data, overwrite=True)

    def test_pr_aggregate_sums_observed_runs_and_marks_antigravity_quota_only(self):
        self._write_summary(_summary(
            "run-codex-1",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 100,
                "output_tokens": 20,
                "reasoning_tokens": 5,
                "cache_read_tokens": 30,
                "cache_write_tokens": 7,
                "total_tokens": 120,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
            pricing={"status": "CALCULATED", "api_equivalent_cost_usd": 0.12, "actual_billed_cost_usd": None},
            timing={"agent_process_seconds": 11.0, "model_event_span_seconds": 9.0},
        ))
        self._write_summary(_summary(
            "run-claude-1",
            4,
            "Claude-Code",
            "DeepSeek",
            {
                "input_tokens": 40,
                "output_tokens": 8,
                "reasoning_tokens": 0,
                "cache_read_tokens": 5,
                "cache_write_tokens": 0,
                "total_tokens": 48,
                "collection_status": "PARTIAL",
                "source": "claude_code_jsonl",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
            pricing={"status": "CALCULATED", "api_equivalent_cost_usd": 0.03, "actual_billed_cost_usd": None},
            timing={"agent_process_seconds": 4.0, "model_event_span_seconds": 3.0},
        ))
        self._write_summary(_summary(
            "run-ag-1",
            4,
            "Antigravity",
            "Google",
            {
                "input_tokens": None,
                "output_tokens": None,
                "reasoning_tokens": None,
                "cache_read_tokens": None,
                "cache_write_tokens": None,
                "total_tokens": None,
                "collection_status": "NOT_AVAILABLE",
                "source": None,
                "correlation_confidence": "NOT_AVAILABLE",
            },
            provider_quota={
                "antigravity_quota": {
                    "status": "COMPLETE",
                    "source": "cockpit_report_http",
                    "provider": "Google",
                }
            },
        ))
        self._write_summary(_summary(
            "run-other-pr",
            5,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 999,
                "output_tokens": 999,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 1998,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
        ))

        aggregate = build_pr_aggregate(self.storage, pr_number=4)

        self.assertEqual(aggregate["scope"], "PR")
        self.assertEqual(aggregate["pr_number"], 4)
        self.assertEqual(aggregate["runs_count"], 3)
        self.assertEqual(aggregate["coverage"]["token_observed_runs"], 2)
        self.assertEqual(aggregate["coverage"]["quota_only_runs"], 1)
        self.assertEqual(aggregate["usage_totals"]["input_tokens"], 140)
        self.assertEqual(aggregate["usage_totals"]["output_tokens"], 28)
        self.assertEqual(aggregate["usage_totals"]["cache_read_tokens"], 35)
        self.assertEqual(aggregate["usage_totals"]["reasoning_tokens"], 5)
        self.assertEqual(aggregate["usage_totals"]["total_tokens"], 168)
        self.assertAlmostEqual(aggregate["pricing_totals"]["api_equivalent_cost_usd"], 0.15)
        self.assertEqual(aggregate["timing"]["agent_process_seconds_sum"], 15.0)
        self.assertEqual(aggregate["timing"]["model_event_span_seconds_sum"], 12.0)
        self.assertEqual(aggregate["unresolved_runs"][0]["run_id"], "run-ag-1")
        self.assertEqual(aggregate["unresolved_runs"][0]["quota_attribution"], "NOT_PROVEN")

    def test_repository_filter_requires_present_matching_identity(self):
        matching = _summary(
            "run-zuno-match",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 10,
                "output_tokens": 1,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 11,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
            repository="ProfessorZhi/Zuno",
        )
        missing_repo = _summary(
            "run-missing-repo",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 999,
                "output_tokens": 1,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 1000,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
            repository=None,
        )
        conflicting_repo = _summary(
            "run-conflicting-repo",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 777,
                "output_tokens": 1,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 778,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
            repository="ProfessorZhi/Other",
        )
        missing_repo["github"] = {}
        conflicting_repo["github"] = {"repository": "ProfessorZhi/Zuno"}

        for item in (matching, missing_repo, conflicting_repo):
            self._write_summary(item)

        aggregate = build_pr_aggregate(self.storage, pr_number=4, repository="ProfessorZhi/Zuno")

        self.assertEqual(aggregate["runs_count"], 1)
        self.assertEqual(aggregate["usage_totals"]["input_tokens"], 10)
        self.assertEqual(aggregate["excluded_run_count"], 2)
        self.assertEqual(
            {item["reason"] for item in aggregate["excluded_runs"]},
            {"repository_identity_missing", "repository_identity_conflict"},
        )

    def test_unreadable_summaries_make_aggregate_partial_with_audit_counts(self):
        self._write_summary(_summary(
            "run-readable",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 1,
                "output_tokens": 1,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 2,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
        ))
        bad_dir = Path(self.temp_dir, "run-bad-summary")
        bad_dir.mkdir(parents=True, exist_ok=True)
        (bad_dir / "sanitized-summary.json").write_text("{ bad json", encoding="utf-8")
        (bad_dir / "sanitized-summary.sha256").write_text("0" * 64, encoding="utf-8")

        aggregate = build_pr_aggregate(self.storage, pr_number=4)

        self.assertEqual(aggregate["aggregate_status"], "PARTIAL")
        self.assertEqual(aggregate["skipped_unreadable_run_count"], 1)
        self.assertEqual(aggregate["integrity_failed_run_count"], 1)
        self.assertEqual(aggregate["skipped_unreadable_runs"][0]["run_id"], "run-bad-summary")
        self.assertIn("unreadable", aggregate["warnings"][-1])

    def test_pr_summary_cli_outputs_aggregate_json(self):
        self._write_summary(_summary(
            "run-codex-cli",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 3,
                "output_tokens": 2,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 5,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
        ))

        with patch("sys.stdout", new=io.StringIO()) as out:
            code = self.cli.cmd_pr_summary(pr_number=4, json_output=True)

        self.assertEqual(code, EXIT_OK)
        data = json.loads(out.getvalue())
        self.assertEqual(data["pr_number"], 4)
        self.assertEqual(data["usage_totals"]["total_tokens"], 5)

    def test_export_pr_aggregate_writes_file_without_run_id(self):
        self._write_summary(_summary(
            "run-export-pr",
            4,
            "Codex",
            "OpenAI",
            {
                "input_tokens": 1,
                "output_tokens": 1,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 2,
                "collection_status": "COMPLETE",
                "source": "codex_exec_json",
                "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
            },
        ))
        out_file = Path(self.temp_dir, "pr-aggregate.json")

        code = self.cli.cmd_export(
            run_id=None,
            output_path=str(out_file),
            format_name="pr-aggregate",
            pr_number=4,
        )

        self.assertEqual(code, EXIT_OK)
        data = json.loads(out_file.read_text(encoding="utf-8"))
        self.assertEqual(data["schema_version"], "agent-metrics-pr-aggregate-v1")
        self.assertEqual(data["usage_totals"]["total_tokens"], 2)

    def test_pr_summary_requires_pr_number(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_pr_summary(pr_number=None, json_output=True)
        self.assertEqual(code, EXIT_INVALID_INPUT)


if __name__ == "__main__":
    unittest.main()
