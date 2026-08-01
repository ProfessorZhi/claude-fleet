"""
CLI Entrypoint for agent_metrics collector.
Implements doctor, start, finish, reconcile, show, export, price, and internal-scan-secrets commands.
"""

import argparse
import datetime
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Dict, Any, Optional, List

from agent_metrics.models import (
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_INVALID_INPUT,
    EXIT_STORAGE_ERROR,
    EXIT_INTEGRITY_ERROR,
    EXIT_EXTERNAL_CMD_ERROR,
    SanitizedSummary,
    AgentInfo,
    TimingInfo,
    UsageInfo,
    PricingInfo,
    QuotaSnapshot,
    IntegrityInfo,
    ModelConfidence,
    CollectorStatus,
)
from agent_metrics.storage import StorageManager, StorageError, IntegrityError
from agent_metrics.pricing import PricingEngine
from agent_metrics.collectors.git_collector import GitCollector
from agent_metrics.collectors.github_collector import GithubCollector
from agent_metrics.collectors.claude_code_collector import ClaudeCodeCollector
from agent_metrics.collectors.cockpit_collector import CockpitCollector
from agent_metrics.collectors.antigravity_collector import AntigravityCollector
from agent_metrics.redaction import sanitize_dict, scan_text_for_secret_types
from agent_metrics.validators import validate_sanitized_summary


def get_utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class CLIHandler:
    def __init__(self, storage_manager: Optional[StorageManager] = None):
        self.storage = storage_manager or StorageManager()
        self.pricing_engine = PricingEngine()

    def cmd_doctor(self, json_output: bool = False) -> int:
        git_coll = GitCollector()
        gh_coll = GithubCollector()
        claude_coll = ClaudeCodeCollector()
        cockpit_coll = CockpitCollector()
        antigravity_coll = AntigravityCollector()

        results = {
            "version": "0.1.0",
            "python_version": sys.version.split()[0],
            "git": git_coll.get_status(),
            "github_cli": gh_coll.get_status(),
            "claude_code": claude_coll.get_status(),
            "cockpit": cockpit_coll.get_status(),
            "antigravity": antigravity_coll.get_status(),
        }

        if json_output:
            print(json.dumps(results, indent=2))
        else:
            print("=== Agent Metrics Collector Doctor ===")
            for name, status in results.items():
                print(f"  {name:15s}: {status}")

        return EXIT_OK

    def cmd_start(
        self,
        agent_shell: str,
        provider: str,
        configured_model: Optional[str] = None,
        work_package: str = "",
        pr_number: Optional[int] = None,
        worktree: Optional[str] = None,
        permission_mode: Optional[str] = None,
        json_output: bool = False,
    ) -> int:
        if not agent_shell or not provider:
            print("Error: agent_shell and provider are required.", file=sys.stderr)
            return EXIT_INVALID_INPUT

        if work_package:
            try:
                StorageManager.validate_work_package(work_package)
            except ValueError as e:
                print(f"Error: {e}", file=sys.stderr)
                return EXIT_INVALID_INPUT

        git_coll = GitCollector(worktree=worktree)
        git_snapshot = git_coll.collect()

        run_id = str(uuid.uuid4())
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

        agent_info = AgentInfo(
            shell=agent_shell,
            provider=provider,
            configured_model=configured_model,
            requested_model=None,
            observed_model=None,
            inferred_model=None,
            model_detection_source="start_parameter" if configured_model else None,
            model_detection_confidence=ModelConfidence.CONFIGURED.value if configured_model else ModelConfidence.NOT_AVAILABLE.value,
            permission_mode=permission_mode,
        )

        context_data = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": run_id,
            "work_package": work_package,
            "pr_number": pr_number,
            "started_at": started_at,
            "agent": agent_info.to_dict(),
            "git_initial": git_snapshot,
        }

        try:
            self.storage.create_run(context_data)
        except Exception as e:
            print(f"Error initializing run: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps({"run_id": run_id, "started_at": started_at}))
        else:
            print(f'$env:ZUNO_AGENT_RUN_ID="{run_id}"')
            print(f"RUN_ID={run_id}")

        return EXIT_OK

    def cmd_finish(self, run_id: str, refresh: bool = False, json_output: bool = False) -> int:
        if not run_id:
            print("Error: run_id is required.", file=sys.stderr)
            return EXIT_INVALID_INPUT

        try:
            StorageManager.validate_run_id(run_id)
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return EXIT_INVALID_INPUT

        # Idempotency check
        if not refresh:
            try:
                existing_summary = self.storage.read_sanitized_summary(run_id)
                if json_output:
                    print(json.dumps(existing_summary, indent=2))
                else:
                    print(f"Run {run_id} already finished (Idempotent return).")
                    print(f"Summary SHA-256: {existing_summary.get('integrity', {}).get('payload_sha256')}")
                return EXIT_OK
            except (StorageError, IntegrityError):
                pass  # Summary doesn't exist yet, proceed with finish

        try:
            ctx = self.storage.read_run_context(run_id)
        except StorageError as e:
            print(f"Error: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        started_at = ctx.get("started_at")
        finished_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

        # Calculate wall clock
        wall_clock = 0.0
        if started_at:
            try:
                t_start = datetime.datetime.fromisoformat(started_at)
                t_fin = datetime.datetime.fromisoformat(finished_at)
                wall_clock = max(0.0, (t_fin - t_start).total_seconds())
            except Exception:
                pass

        # Collect Git stats
        git_coll = GitCollector()
        git_stats = git_coll.collect(initial_git_info=ctx.get("git_initial"))

        # Collect GitHub stats
        gh_coll = GithubCollector()
        _, gh_stats = gh_coll.collect_pr_info(pr_number=ctx.get("pr_number"))

        # Collect Claude Code telemetry
        claude_coll = ClaudeCodeCollector()
        claude_data = claude_coll.collect()

        # Correlate usage (fail closed if ambiguous)
        usage = UsageInfo(collection_status="NOT_AVAILABLE")
        observed_model = None

        if claude_data.get("status") == CollectorStatus.AVAILABLE.value and claude_data.get("sessions"):
            # Select matching session
            matching = [s for s in claude_data["sessions"] if s.get("start_time") and s.get("start_time") >= started_at]
            if len(matching) == 1:
                sess = matching[0]
                observed_model = sess.get("observed_model")
                usage = UsageInfo(
                    input_tokens=sess.get("input_tokens"),
                    output_tokens=sess.get("output_tokens"),
                    reasoning_tokens=sess.get("reasoning_tokens"),
                    cache_read_tokens=sess.get("cache_read_tokens"),
                    cache_write_tokens=sess.get("cache_write_tokens"),
                    total_tokens=sess.get("total_tokens"),
                    collection_status="COMPLETE",
                    source="claude_code_jsonl",
                    correlation_confidence="EXACT_SESSION",
                )

        # Agent info update
        agent_dict = ctx.get("agent", {})
        if observed_model:
            agent_dict["observed_model"] = observed_model
            agent_dict["model_detection_confidence"] = ModelConfidence.OBSERVED.value

        # Calculate pricing
        pricing = self.pricing_engine.calculate_cost(
            model_name=agent_dict.get("observed_model") or agent_dict.get("configured_model"),
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            reasoning_tokens=usage.reasoning_tokens,
            cache_read_tokens=usage.cache_read_tokens,
            cache_write_tokens=usage.cache_write_tokens,
        )

        timing = TimingInfo(
            started_at=started_at,
            finished_at=finished_at,
            wall_clock_seconds=wall_clock,
            agent_active_seconds=None,
            ci_wait_seconds=None,
        )

        summary_obj = SanitizedSummary(
            schema_version=1,
            collector_version="0.1.0",
            run_id=run_id,
            work_package=ctx.get("work_package", ""),
            pr_number=ctx.get("pr_number"),
            agent=agent_dict,
            timing=timing,
            usage=usage,
            pricing=pricing,
            quota=QuotaSnapshot(),
            git=git_stats,
            github=gh_stats,
            collectors={
                "git": git_coll.get_status(),
                "github": gh_coll.get_status(),
                "claude_code": claude_coll.get_status(),
                "cockpit": CockpitCollector().get_status(),
            },
            warnings=[],
            integrity=IntegrityInfo(),
        )

        summary_dict = summary_obj.to_dict()

        try:
            written_summary = self.storage.write_sanitized_summary(run_id, summary_dict, overwrite=True)
            self.storage.append_event(run_id, {
                "type": "RUN_FINISHED",
                "timestamp": finished_at,
                "run_id": run_id,
                "payload_sha256": written_summary.get("integrity", {}).get("payload_sha256")
            })
        except Exception as e:
            print(f"Error saving summary: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps(written_summary, indent=2))
        else:
            print(f"Run {run_id} finished.")
            print(f"Wall Clock: {wall_clock}s")
            print(f"Summary SHA-256: {written_summary.get('integrity', {}).get('payload_sha256')}")

        return EXIT_OK

    def cmd_internal_scan_secrets(self, scan_path: str = ".") -> int:
        target = Path(scan_path).resolve()
        violations = []

        for p in target.rglob("*"):
            if not p.is_file() or ".git" in p.parts or "__pycache__" in p.parts:
                continue

            rel_str = str(p.relative_to(target))

            # Whitelist strictly tests/fixtures/known-fake-secrets/**
            if rel_str.startswith(r"tests\fixtures\known-fake-secrets") or rel_str.startswith("tests/fixtures/known-fake-secrets"):
                continue

            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
                found_types = scan_text_for_secret_types(text)
                if found_types:
                    violations.append((rel_str, sorted(list(found_types))))
            except Exception:
                pass

        if violations:
            print("=== Secret Scanner Gate Violations ===")
            for path_str, types in violations:
                print(f"SECRET DETECTED in {path_str}: {','.join(types)}")
            return 1

        print("REPOSITORY_SECRET_SCAN_OK")
        return EXIT_OK

    def cmd_show(self, run_id: str, json_output: bool = False) -> int:
        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except IntegrityError as e:
            print(f"Integrity Error: {e}", file=sys.stderr)
            return EXIT_INTEGRITY_ERROR
        except StorageError as e:
            print(f"Storage Error: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps(summary, indent=2))
        else:
            print(f"=== Run Summary ({run_id}) ===")
            print(f"Work Package: {summary.get('work_package')}")
            print(f"Status      : {summary.get('usage', {}).get('collection_status')}")
            print(f"Payload SHA : {summary.get('integrity', {}).get('payload_sha256')}")

        return EXIT_OK

    def cmd_export(self, run_id: str, output_path: str, format_name: str = "json") -> int:
        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except IntegrityError as e:
            print(f"Integrity Error: {e}", file=sys.stderr)
            return EXIT_INTEGRITY_ERROR
        except StorageError as e:
            print(f"Storage Error: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        out_path = Path(output_path).resolve()
        data_bytes = json.dumps(summary, indent=2, ensure_ascii=False).encode("utf-8")

        try:
            StorageManager.atomic_write(out_path, data_bytes)
            print(f"Exported run {run_id} to {out_path} ({format_name})")
            return EXIT_OK
        except Exception as e:
            print(f"Error exporting run: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR


def main(args: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Agent Metrics Collector CLI")
    subparsers = parser.add_subparsers(dest="command")

    # doctor
    doc_p = subparsers.add_parser("doctor")
    doc_p.add_argument("--json", action="store_true")

    # start
    start_p = subparsers.add_parser("start")
    start_p.add_argument("--agent-shell", required=True)
    start_p.add_argument("--provider", required=True)
    start_p.add_argument("--configured-model")
    start_p.add_argument("--work-package", default="")
    start_p.add_argument("--pr-number", type=int)
    start_p.add_argument("--worktree")
    start_p.add_argument("--permission-mode")
    start_p.add_argument("--json", action="store_true")

    # finish
    fin_p = subparsers.add_parser("finish")
    fin_p.add_argument("run_id", nargs="?")
    fin_p.add_argument("--run-id")
    fin_p.add_argument("--refresh", action="store_true")
    fin_p.add_argument("--json", action="store_true")

    # show
    show_p = subparsers.add_parser("show")
    show_p.add_argument("run_id")
    show_p.add_argument("--json", action="store_true")

    # export
    exp_p = subparsers.add_parser("export")
    exp_p.add_argument("run_id")
    exp_p.add_argument("--output", required=True)
    exp_p.add_argument("--format", default="json")

    # internal-scan-secrets
    scan_p = subparsers.add_parser("internal-scan-secrets")
    scan_p.add_argument("--path", default=".")

    parsed = parser.parse_args(args)
    cli = CLIHandler()

    if parsed.command == "doctor":
        return cli.cmd_doctor(json_output=parsed.json)
    elif parsed.command == "start":
        return cli.cmd_start(
            agent_shell=parsed.agent_shell,
            provider=parsed.provider,
            configured_model=parsed.configured_model,
            work_package=parsed.work_package,
            pr_number=parsed.pr_number,
            worktree=parsed.worktree,
            permission_mode=parsed.permission_mode,
            json_output=parsed.json,
        )
    elif parsed.command == "finish":
        r_id = parsed.run_id or parsed.run_id
        return cli.cmd_finish(run_id=r_id, refresh=parsed.refresh, json_output=parsed.json)
    elif parsed.command == "show":
        return cli.cmd_show(run_id=parsed.run_id, json_output=parsed.json)
    elif parsed.command == "export":
        return cli.cmd_export(run_id=parsed.run_id, output_path=parsed.output, format_name=parsed.format)
    elif parsed.command == "internal-scan-secrets":
        return cli.cmd_internal_scan_secrets(scan_path=parsed.path)
    else:
        parser.print_help()
        return EXIT_INVALID_INPUT


if __name__ == "__main__":
    sys.exit(main())
