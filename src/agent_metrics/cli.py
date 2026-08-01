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

        all_available = all(v == CollectorStatus.AVAILABLE.value for k, v in results.items() if k not in ("version", "python_version"))

        if json_output:
            print(json.dumps(results, indent=2))
        else:
            print("=== Agent Metrics Collector Doctor ===")
            for name, status in results.items():
                print(f"  {name:15s}: {status}")

        return EXIT_OK if all_available else EXIT_PARTIAL

    def cmd_start(
        self,
        agent_shell: str,
        provider: str,
        configured_model: Optional[str] = None,
        work_package: str = "",
        pr_number: Optional[int] = None,
        repository: Optional[str] = None,
        worktree: Optional[str] = None,
        session_id: Optional[str] = None,
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

        target_worktree = worktree or os.getcwd()
        git_coll = GitCollector(worktree=target_worktree)
        git_snapshot = git_coll.collect()

        run_id = str(uuid.uuid4())
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

        claude_coll = ClaudeCodeCollector()
        claude_baseline = claude_coll.create_session_baseline()

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
            "repository": repository,
            "worktree": target_worktree,
            "session_id": session_id,
            "started_at": started_at,
            "agent": agent_info.to_dict(),
            "git_initial": git_snapshot,
            "claude_session_baseline": claude_baseline,
        }

        try:
            self.storage.create_run(context_data)
        except Exception as e:
            print(f"Error initializing run: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps({"run_id": run_id, "started_at": started_at}))
        else:
            print(f"RUN_ID={run_id}")
            print(f'$env:ZUNO_AGENT_RUN_ID="{run_id}"')

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

        # Integrity fail-closed check on existing summary
        run_dir = self.storage.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        if summary_file.exists():
            try:
                existing_summary = self.storage.read_sanitized_summary(run_id)
                if not refresh:
                    if json_output:
                        print(json.dumps(existing_summary, indent=2))
                    else:
                        print(f"Run {run_id} already finished (Idempotent return).")
                        print(f"Summary SHA-256: {existing_summary.get('integrity', {}).get('payload_sha256')}")
                    return EXIT_OK
            except IntegrityError as e:
                print(f"Integrity Error: {e}", file=sys.stderr)
                return EXIT_INTEGRITY_ERROR
            except StorageError as e:
                print(f"Storage Error: {e}", file=sys.stderr)
                return EXIT_STORAGE_ERROR

        try:
            ctx = self.storage.read_run_context(run_id)
        except StorageError as e:
            print(f"Error: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        started_at = ctx.get("started_at")
        finished_at = get_utc_now_iso()

        # Calculate wall clock
        wall_clock = 0.0
        if started_at:
            try:
                t_start = datetime.datetime.fromisoformat(started_at)
                t_fin = datetime.datetime.fromisoformat(finished_at)
                wall_clock = max(0.0, (t_fin - t_start).total_seconds())
            except Exception:
                pass

        target_worktree = ctx.get("worktree") or os.getcwd()
        target_repo = ctx.get("repository")

        # Collect Git stats from target worktree
        git_coll = GitCollector(worktree=target_worktree)
        git_stats = git_coll.collect(run_context=ctx, initial_git_info=ctx.get("git_initial"))

        # Collect GitHub stats
        gh_coll = GithubCollector(worktree=target_worktree, repository=target_repo)
        code_gh, gh_stats = gh_coll.collect_pr_info(pr_number=ctx.get("pr_number"))

        # Telemetry collection based on agent shell
        agent_shell = ctx.get("agent", {}).get("shell", "")
        usage = UsageInfo(collection_status="NOT_AVAILABLE")
        observed_model = None

        if agent_shell.lower() in ("claude-code", "claudecode", "claude"):
            claude_coll = ClaudeCodeCollector()
            claude_res = claude_coll.collect(run_context=ctx)
            if claude_res.get("matched_session"):
                sess = claude_res["matched_session"]
                observed_model = sess.get("observed_model")
                usage = UsageInfo(
                    input_tokens=sess.get("input_tokens"),
                    output_tokens=sess.get("output_tokens"),
                    reasoning_tokens=sess.get("reasoning_tokens"),
                    cache_read_tokens=sess.get("cache_read_tokens"),
                    cache_write_tokens=sess.get("cache_write_tokens"),
                    total_tokens=sess.get("total_tokens"),
                    collection_status="COMPLETE" if sess.get("total_tokens") else "NOT_AVAILABLE",
                    source="claude_code_jsonl",
                    correlation_confidence=claude_res.get("correlation_confidence", "NOT_AVAILABLE"),
                )
        elif agent_shell.lower() in ("antigravity", "agy"):
            antigravity_coll = AntigravityCollector()
            antigravity_res = antigravity_coll.collect(run_context=ctx)
            if isinstance(antigravity_res.get("usage"), dict):
                usage = UsageInfo(**antigravity_res["usage"])

        # Agent info update
        agent_dict = dict(ctx.get("agent", {}))
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
            provider=agent_dict.get("provider"),
        )

        timing = TimingInfo(
            started_at=started_at,
            finished_at=finished_at,
            wall_clock_seconds=wall_clock,
            agent_active_seconds=None,
            ci_wait_seconds=gh_stats.get("ci_wait_seconds"),
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
                "claude_code": ClaudeCodeCollector().get_status(),
                "cockpit": CockpitCollector().get_status(),
                "antigravity": AntigravityCollector().get_status(),
            },
            warnings=[],
            integrity=IntegrityInfo(),
        )

        summary_dict = summary_obj.to_dict()
        summary_dict["repository"] = target_repo
        summary_dict["worktree"] = target_worktree
        summary_dict["session_id"] = ctx.get("session_id")

        try:
            written_summary = self.storage.write_sanitized_summary(run_id, summary_dict, overwrite=True)
            self.storage.append_event(run_id, {
                "event_id": str(uuid.uuid4()),
                "event_type": "RUN_FINISHED",
                "observed_at": finished_at,
                "source": "cli_finish",
                "run_id": run_id,
                "payload_hash": written_summary.get("integrity", {}).get("payload_sha256")
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

    def cmd_reconcile(
        self,
        run_id: str,
        repository: Optional[str] = None,
        pr_number: Optional[int] = None,
        json_output: bool = False,
    ) -> int:
        if not run_id:
            print("Error: run_id is required.", file=sys.stderr)
            return EXIT_INVALID_INPUT

        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except (StorageError, IntegrityError):
            try:
                ctx = self.storage.read_run_context(run_id)
                summary = {
                    "schema_version": 1,
                    "collector_version": "0.1.0",
                    "run_id": run_id,
                    "work_package": ctx.get("work_package", ""),
                    "pr_number": pr_number or ctx.get("pr_number"),
                    "repository": repository or ctx.get("repository"),
                    "worktree": ctx.get("worktree"),
                    "agent": ctx.get("agent", {}),
                    "github": {},
                }
            except Exception as e:
                print(f"Error reading run context: {e}", file=sys.stderr)
                return EXIT_STORAGE_ERROR

        pr_num = pr_number or summary.get("pr_number")
        target_repo = repository or summary.get("repository")
        target_worktree = summary.get("worktree") or os.getcwd()

        gh_coll = GithubCollector(worktree=target_worktree, repository=target_repo)
        code_gh, gh_stats = gh_coll.collect_pr_info(pr_number=pr_num)

        summary["github"] = gh_stats
        if pr_num:
            summary["pr_number"] = pr_num
        if target_repo:
            summary["repository"] = target_repo

        try:
            written = self.storage.write_sanitized_summary(run_id, summary, overwrite=True)
            self.storage.append_event(run_id, {
                "event_id": str(uuid.uuid4()),
                "event_type": "RUN_RECONCILED",
                "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "source": "cli_reconcile",
                "run_id": run_id,
                "payload_hash": written.get("integrity", {}).get("payload_sha256"),
            })
            if json_output:
                print(json.dumps(written, indent=2))
            else:
                print(f"Reconciled run {run_id} with PR #{pr_num}.")
            return EXIT_OK
        except Exception as e:
            print(f"Error saving summary: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

    def cmd_show(self, run_id: str, json_output: bool = False) -> int:
        if not run_id:
            print("Error: run_id is required.", file=sys.stderr)
            return EXIT_INVALID_INPUT

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

    def cmd_export(
        self,
        run_id: str,
        output_path: str,
        format_name: str = "json",
        format_type: Optional[str] = None,
    ) -> int:
        if not run_id or not output_path:
            print("Error: run_id and output_path are required.", file=sys.stderr)
            return EXIT_INVALID_INPUT

        fmt = format_type or format_name
        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except IntegrityError as e:
            print(f"Integrity Error: {e}", file=sys.stderr)
            return EXIT_INTEGRITY_ERROR
        except StorageError as e:
            print(f"Storage Error: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

        out_path = Path(output_path).resolve()
        if fmt == "zuno-pr-record-fragment":
            export_data = {
                "schema_version": "zuno-pr-record-fragment-v1",
                "collector_version": summary.get("collector_version", "0.1.0"),
                "run_id": summary.get("run_id"),
                "work_package": summary.get("work_package"),
                "pr_number": summary.get("pr_number"),
                "repository": summary.get("repository"),
                "agent": summary.get("agent"),
                "timing": summary.get("timing"),
                "usage": summary.get("usage"),
                "pricing": summary.get("pricing"),
                "git": summary.get("git"),
                "github": summary.get("github"),
            }
        else:
            export_data = summary

        data_bytes = json.dumps(export_data, indent=2, ensure_ascii=False).encode("utf-8")

        try:
            StorageManager.atomic_write(out_path, data_bytes)
            print(f"Exported run {run_id} to {out_path} ({fmt})")
            return EXIT_OK
        except Exception as e:
            print(f"Error exporting run: {e}", file=sys.stderr)
            return EXIT_STORAGE_ERROR

    def cmd_price(
        self,
        model: str,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        provider: Optional[str] = None,
        json_output: bool = False,
    ) -> int:
        pricing_info = self.pricing_engine.calculate_cost(
            model_name=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            provider=provider,
        )

        if json_output:
            print(json.dumps(pricing_info.to_dict(), indent=2))
        else:
            print(f"Price Status : {pricing_info.status}")
            print(f"Cost (USD)   : {pricing_info.api_equivalent_cost_usd}")

        if pricing_info.status == "CALCULATED":
            return EXIT_OK
        elif pricing_info.status in ("UNVERIFIED", "PRICE_NOT_AVAILABLE"):
            return EXIT_PARTIAL
        elif pricing_info.status == "INVALID_USAGE":
            return EXIT_INVALID_INPUT
        return EXIT_PARTIAL

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
    start_p.add_argument("--repository")
    start_p.add_argument("--worktree")
    start_p.add_argument("--session-id")
    start_p.add_argument("--permission-mode")
    start_p.add_argument("--json", action="store_true")

    # finish
    fin_p = subparsers.add_parser("finish")
    fin_p.add_argument("pos_run_id", nargs="?")
    fin_p.add_argument("--run-id", dest="kw_run_id")
    fin_p.add_argument("--refresh", action="store_true")
    fin_p.add_argument("--json", action="store_true")

    # show
    show_p = subparsers.add_parser("show")
    show_p.add_argument("pos_run_id", nargs="?")
    show_p.add_argument("--run-id", dest="kw_run_id")
    show_p.add_argument("--json", action="store_true")

    # export
    exp_p = subparsers.add_parser("export")
    exp_p.add_argument("pos_run_id", nargs="?")
    exp_p.add_argument("pos_output_path", nargs="?")
    exp_p.add_argument("--run-id", dest="kw_run_id")
    exp_p.add_argument("--output-path", dest="kw_output_path")
    exp_p.add_argument("--output", dest="kw_output")
    exp_p.add_argument("--format", dest="format_name", default="json")
    exp_p.add_argument("--format-type", dest="format_type", default=None)

    # reconcile
    rec_p = subparsers.add_parser("reconcile")
    rec_p.add_argument("pos_run_id", nargs="?")
    rec_p.add_argument("--run-id", dest="kw_run_id")
    rec_p.add_argument("--repository")
    rec_p.add_argument("--pr-number", type=int)
    rec_p.add_argument("--json", action="store_true")

    # price
    price_p = subparsers.add_parser("price")
    price_p.add_argument("--model", required=True)
    price_p.add_argument("--input-tokens", type=int)
    price_p.add_argument("--output-tokens", type=int)
    price_p.add_argument("--reasoning-tokens", type=int)
    price_p.add_argument("--cache-read-tokens", type=int)
    price_p.add_argument("--cache-write-tokens", type=int)
    price_p.add_argument("--provider")
    price_p.add_argument("--json", action="store_true")

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
            repository=parsed.repository,
            worktree=parsed.worktree,
            session_id=parsed.session_id,
            permission_mode=parsed.permission_mode,
            json_output=parsed.json,
        )
    elif parsed.command == "finish":
        r_id = parsed.kw_run_id or parsed.pos_run_id
        return cli.cmd_finish(run_id=r_id, refresh=parsed.refresh, json_output=parsed.json)
    elif parsed.command == "reconcile":
        r_id = parsed.kw_run_id or parsed.pos_run_id
        return cli.cmd_reconcile(run_id=r_id, repository=parsed.repository, pr_number=parsed.pr_number, json_output=parsed.json)
    elif parsed.command == "show":
        r_id = parsed.kw_run_id or parsed.pos_run_id
        return cli.cmd_show(run_id=r_id, json_output=parsed.json)
    elif parsed.command == "export":
        r_id = parsed.kw_run_id or parsed.pos_run_id
        out_p = parsed.kw_output_path or parsed.kw_output or parsed.pos_output_path
        return cli.cmd_export(run_id=r_id, output_path=out_p, format_name=parsed.format_name, format_type=parsed.format_type)
    elif parsed.command == "price":
        return cli.cmd_price(
            model=parsed.model,
            input_tokens=parsed.input_tokens,
            output_tokens=parsed.output_tokens,
            reasoning_tokens=parsed.reasoning_tokens,
            cache_read_tokens=parsed.cache_read_tokens,
            cache_write_tokens=parsed.cache_write_tokens,
            provider=parsed.provider,
            json_output=parsed.json,
        )
    elif parsed.command == "internal-scan-secrets":
        return cli.cmd_internal_scan_secrets(scan_path=parsed.path)
    else:
        parser.print_help()
        return EXIT_INVALID_INPUT


if __name__ == "__main__":
    sys.exit(main())
