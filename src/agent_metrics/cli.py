"""
CLI entrypoint and command handlers for agent-metrics-collector.
"""

import argparse
import datetime
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional

from . import __version__
from .models import (
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_INVALID_INPUT,
    EXIT_STORAGE_ERROR,
    EXIT_INTEGRITY_ERROR,
    EXIT_EXTERNAL_CMD_ERROR,
    CollectorStatus,
    SanitizedSummary,
    AgentInfo,
    TimingInfo,
    UsageInfo,
    PricingInfo,
)
from .storage import StorageManager
from .redaction import redact_data, scan_text_for_secret_types
from .integrity import compute_sha256
from .pricing import PricingEngine
from .collectors.git_collector import GitCollector
from .collectors.github_collector import GithubCollector
from .collectors.claude_code_collector import ClaudeCodeCollector
from .collectors.cockpit_collector import CockpitCollector
from .collectors.antigravity_collector import AntigravityCollector


def get_utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def get_local_tz_name() -> str:
    try:
        return datetime.datetime.now().astimezone().tzname() or "Local"
    except Exception:
        return "Local"


class CLIHandler:
    def __init__(self, storage_manager: Optional[StorageManager] = None):
        self.storage = storage_manager or StorageManager()
        self.git_collector = GitCollector()
        self.github_collector = GithubCollector()
        self.claude_collector = ClaudeCodeCollector()
        self.cockpit_collector = CockpitCollector()
        self.antigravity_collector = AntigravityCollector(cockpit_collector=self.cockpit_collector)
        self.pricing_engine = PricingEngine()

    def cmd_doctor(self, json_output: bool = False) -> int:
        py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"

        git_status = self.git_collector.check_availability()
        github_status = self.github_collector.check_availability()
        claude_status = self.claude_collector.check_availability()
        cockpit_status = self.cockpit_collector.check_availability()
        antigravity_status = self.antigravity_collector.check_availability()

        base_url = self.cockpit_collector.get_base_url()
        cockpit_proc = self.cockpit_collector.is_cockpit_process_running()
        cliproxy_proc = self.cockpit_collector.is_cliproxy_process_running()

        quota_data, quota_conf = self.cockpit_collector.fetch_quota_snapshot()
        events, event_conf = self.cockpit_collector.fetch_cliproxy_usage_events(
            started_at=get_utc_now_iso(), finished_at=None
        )

        doctor_res = {
            "version": __version__,
            "python_version": py_ver,
            "git": git_status,
            "github_cli": github_status,
            "claude_code": claude_status,
            "cockpit": cockpit_status,
            "cockpit_diagnostics": {
                "cockpit_client_detected": "Yes" if cockpit_proc else "No",
                "cliproxy_process_detected": "Yes" if cliproxy_proc else "No",
                "cliproxy_port_detected": "Yes" if base_url else "No",
                "quota_surface_detected": "Yes" if quota_data else "No",
                "request_usage_surface_detected": "Yes" if events else "No",
                "antigravity_traffic_proven_through_cliproxy": "Yes" if (events and cliproxy_proc) else "Not proven",
            },
            "antigravity_logs": antigravity_status,
        }

        if json_output:
            print(json.dumps(doctor_res, indent=2))
        else:
            print(f"Agent Metrics Collector Doctor v{__version__}")
            print(f"Python Version: {py_ver}")
            print(f"Git Collector: {git_status}")
            print(f"GitHub CLI Collector: {github_status}")
            print(f"Claude Code Collector: {claude_status}")
            print(f"Cockpit Collector: {cockpit_status}")
            print(f"  - Cockpit Client Detected: {doctor_res['cockpit_diagnostics']['cockpit_client_detected']}")
            print(f"  - CLIProxy Process Detected: {doctor_res['cockpit_diagnostics']['cliproxy_process_detected']}")
            print(f"  - CLIProxy Port Detected: {doctor_res['cockpit_diagnostics']['cliproxy_port_detected']}")
            print(f"  - Quota Surface Detected: {doctor_res['cockpit_diagnostics']['quota_surface_detected']}")
            print(f"  - Request Usage Surface Detected: {doctor_res['cockpit_diagnostics']['request_usage_surface_detected']}")
            print(f"  - Antigravity Traffic Proven: {doctor_res['cockpit_diagnostics']['antigravity_traffic_proven_through_cliproxy']}")
            print(f"Antigravity Collector: {antigravity_status}")

        all_ok = all(
            st in (CollectorStatus.AVAILABLE.value, CollectorStatus.CONFIG_REQUIRED.value)
            for st in [git_status, github_status, claude_status, cockpit_status, antigravity_status]
        )
        return EXIT_OK if all_ok else EXIT_PARTIAL

    def cmd_start(
        self,
        agent_shell: str,
        provider: str,
        configured_model: Optional[str] = None,
        work_package: str = "",
        pr_number: Optional[int] = None,
        worktree: str = "",
        session_id: Optional[str] = None,
        json_output: bool = False,
    ) -> int:
        if not agent_shell or not provider:
            sys.stderr.write("Error: --agent-shell and --provider are required.\n")
            return EXIT_INVALID_INPUT

        run_id = str(uuid.uuid4())
        started_at = get_utc_now_iso()
        tz_name = get_local_tz_name()

        # Git snapshot
        git_info = self.git_collector.get_git_snapshot(worktree)

        # Baseline Quota Snapshot
        quota_before, _ = self.cockpit_collector.fetch_quota_snapshot()

        run_context = {
            "schema_version": 1,
            "collector_version": __version__,
            "run_id": run_id,
            "work_package": work_package,
            "pr_number": pr_number,
            "worktree": worktree,
            "session_id": session_id,
            "started_at": started_at,
            "timezone": tz_name,
            "pid": os.getpid(),
            "agent": {
                "shell": agent_shell,
                "provider": provider,
                "configured_model": configured_model,
            },
            "initial_git": git_info.to_dict(),
            "quota_before": quota_before,
        }

        try:
            self.storage.init_run(run_context)
        except Exception as e:
            sys.stderr.write(f"Storage error initializing run: {e}\n")
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps({"run_id": run_id, "started_at": started_at, "status": "STARTED"}, indent=2))

        print(f'$env:ZUNO_AGENT_RUN_ID="{run_id}"')
        print(f"RUN_ID={run_id}")
        return EXIT_OK

    def cmd_finish(self, run_id: str, json_output: bool = False) -> int:
        try:
            run_context = self.storage.read_run_context(run_id)
        except Exception as e:
            sys.stderr.write(f"Error reading run context for ID '{run_id}': {e}\n")
            return EXIT_STORAGE_ERROR

        finished_at = get_utc_now_iso()

        # Parse wall clock
        started_at_str = run_context.get("started_at", "")
        wall_clock = None
        if started_at_str:
            try:
                s_dt = datetime.datetime.fromisoformat(started_at_str.replace("Z", "+00:00"))
                f_dt = datetime.datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
                wall_clock = max(0.0, (f_dt - s_dt).total_seconds())
            except Exception:
                pass

        worktree = run_context.get("worktree", "")
        final_git = self.git_collector.get_git_snapshot(worktree)
        initial_git = run_context.get("initial_git", {})

        merged_git = {
            "initial_branch": initial_git.get("initial_branch"),
            "initial_head_sha": initial_git.get("initial_head_sha"),
            "initial_clean": initial_git.get("initial_clean"),
            "final_branch": final_git.final_branch,
            "final_head_sha": final_git.final_head_sha,
            "final_clean": final_git.final_clean,
            "commit_count": final_git.commit_count,
            "files_changed": final_git.files_changed,
            "additions": final_git.additions,
            "deletions": final_git.deletions,
        }

        # Quota after
        quota_after, _ = self.cockpit_collector.fetch_quota_snapshot()
        quota_before = run_context.get("quota_before")

        quota_snapshot = {
            "before": quota_before,
            "after": quota_after,
            "delta": None,
            "reset_time": quota_after.get("reset_time") if quota_after else None,
            "subscription_tier": quota_after.get("subscription_tier") if quota_after else None,
            "source": "cockpit" if (quota_before or quota_after) else None,
        }

        agent_shell = run_context.get("agent", {}).get("shell", "")
        provider = run_context.get("agent", {}).get("provider", "")
        configured_model = run_context.get("agent", {}).get("configured_model")

        # Collect usage depending on agent shell
        collected_usage = UsageInfo()
        agent_info = AgentInfo(
            shell=agent_shell,
            provider=provider,
            configured_model=configured_model,
        )

        collector_results = {}

        if agent_shell.lower() in ("claude-code", "claude_code", "claude"):
            c_res = self.claude_collector.collect(
                {
                    "session_id": run_context.get("session_id"),
                    "worktree": worktree,
                    "work_package": run_context.get("work_package"),
                    "started_at": started_at_str,
                    "finished_at": finished_at,
                }
            )
            collector_results["claude_code"] = c_res
            u_dict = c_res.get("usage", {})
            collected_usage = UsageInfo(**u_dict) if u_dict else UsageInfo()

            meta = c_res.get("agent_metadata", {})
            agent_info.requested_model = meta.get("requested_model") or configured_model
            agent_info.observed_model = meta.get("observed_model")
            agent_info.permission_mode = meta.get("permission_mode")
            if agent_info.observed_model:
                agent_info.model_detection_source = "claude_code_session"
                agent_info.model_detection_confidence = "OBSERVED"
            elif configured_model:
                agent_info.model_detection_source = "configured"
                agent_info.model_detection_confidence = "CONFIGURED"

        elif agent_shell.lower() in ("antigravity", "google-antigravity"):
            ag_res = self.antigravity_collector.collect(
                {
                    "started_at": started_at_str,
                    "finished_at": finished_at,
                    "configured_model": configured_model,
                }
            )
            collector_results["antigravity"] = ag_res
            u_dict = ag_res.get("usage", {})
            collected_usage = UsageInfo(**u_dict) if u_dict else UsageInfo()

            m_info = ag_res.get("model_info", {})
            agent_info.requested_model = m_info.get("requested_model") or configured_model
            agent_info.observed_model = m_info.get("observed_model")
            agent_info.model_detection_source = m_info.get("detection_source")
            agent_info.model_detection_confidence = m_info.get("detection_confidence", "NOT_AVAILABLE")
        else:
            collected_usage = UsageInfo(collection_status="NOT_AVAILABLE")

        # Price calculation
        pricing_info = self.pricing_engine.calculate_cost(
            provider=provider,
            model_name=agent_info.observed_model or configured_model or "",
            input_tokens=collected_usage.input_tokens,
            output_tokens=collected_usage.output_tokens,
            reasoning_tokens=collected_usage.reasoning_tokens,
            cache_read_tokens=collected_usage.cache_read_tokens,
            cache_write_tokens=collected_usage.cache_write_tokens,
        )

        timing_info = TimingInfo(
            started_at=started_at_str,
            finished_at=finished_at,
            wall_clock_seconds=wall_clock,
            agent_active_seconds=None,  # null without telemetry
            ci_wait_seconds=None,
        )

        raw_summary_dict = SanitizedSummary(
            schema_version=1,
            collector_version=__version__,
            run_id=run_id,
            work_package=run_context.get("work_package", ""),
            pr_number=run_context.get("pr_number"),
            agent=agent_info,
            timing=timing_info,
            usage=collected_usage,
            pricing=pricing_info,
            quota=quota_snapshot,
            git=merged_git,
            github=run_context.get("github", {}),
            collectors=collector_results,
            warnings=[],
            integrity={"summary_sha256": None},
        ).to_dict()

        # Run redaction scanner
        sanitized_dict, redaction_warnings = redact_data(raw_summary_dict)
        if redaction_warnings:
            sanitized_dict["warnings"] = list(set(sanitized_dict.get("warnings", []) + redaction_warnings))

        try:
            summary_file, sha_file, sha_val = self.storage.write_sanitized_summary(run_id, sanitized_dict)
        except Exception as e:
            sys.stderr.write(f"Error saving sanitized summary: {e}\n")
            return EXIT_STORAGE_ERROR

        # Log event
        self.storage.append_event(
            run_id=run_id,
            event_type="RUN_FINISHED",
            source="CLI",
            payload={"finished_at": finished_at, "summary_sha256": sha_val},
        )

        if json_output:
            print(json.dumps(sanitized_dict, indent=2))
        else:
            print(f"Run {run_id} finished.")
            print(f"Wall Clock: {wall_clock}s")
            print(f"Collection Status: {collected_usage.collection_status}")
            print(f"Summary SHA-256: {sha_val}")

        return EXIT_OK

    def cmd_reconcile(self, run_id: str, repository: Optional[str] = None, pr_number: Optional[int] = None) -> int:
        try:
            summary_dict = self.storage.read_sanitized_summary(run_id)
        except Exception:
            try:
                run_context = self.storage.read_run_context(run_id)
                summary_dict = {"run_id": run_id, "work_package": run_context.get("work_package")}
            except Exception as e:
                sys.stderr.write(f"Error finding run for reconciliation: {e}\n")
                return EXIT_STORAGE_ERROR

        target_pr = pr_number or summary_dict.get("pr_number")
        if not target_pr:
            sys.stderr.write("Error: --pr-number is required for reconcile.\n")
            return EXIT_INVALID_INPUT

        gh_info = self.github_collector.query_pr_details(repository, int(target_pr))
        summary_dict["github"] = gh_info.to_dict()
        summary_dict["pr_number"] = int(target_pr)

        if gh_info.ci_duration_seconds is not None:
            if "timing" in summary_dict and isinstance(summary_dict["timing"], dict):
                summary_dict["timing"]["ci_wait_seconds"] = gh_info.ci_duration_seconds

        sanitized_dict, redaction_warnings = redact_data(summary_dict)
        if redaction_warnings:
            sanitized_dict["warnings"] = list(set(sanitized_dict.get("warnings", []) + redaction_warnings))

        try:
            _, _, sha_val = self.storage.write_sanitized_summary(run_id, sanitized_dict)
        except Exception as e:
            sys.stderr.write(f"Storage error saving reconciled summary: {e}\n")
            return EXIT_STORAGE_ERROR

        self.storage.append_event(
            run_id=run_id,
            event_type="RECONCILED",
            source="CLI",
            payload={"pr_number": target_pr, "sha256": sha_val},
        )

        print(f"Reconciled run {run_id} with PR #{target_pr}. SHA-256: {sha_val}")
        return EXIT_OK

    def cmd_show(self, run_id: str, json_output: bool = False) -> int:
        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except Exception as e:
            sys.stderr.write(f"Error reading summary for run {run_id}: {e}\n")
            return EXIT_STORAGE_ERROR

        if json_output:
            print(json.dumps(summary, indent=2))
        else:
            print(f"--- Sanitized Summary for Run {run_id} ---")
            print(f"Work Package: {summary.get('work_package')}")
            print(f"Agent Shell: {summary.get('agent', {}).get('shell')}")
            print(f"Provider: {summary.get('agent', {}).get('provider')}")
            print(f"Configured Model: {summary.get('agent', {}).get('configured_model')}")
            print(f"Observed Model: {summary.get('agent', {}).get('observed_model')}")
            print(f"Collection Status: {summary.get('usage', {}).get('collection_status')}")
            print(f"Total Tokens: {summary.get('usage', {}).get('total_tokens')}")
            print(f"API Equivalent Cost (USD): {summary.get('pricing', {}).get('api_equivalent_cost_usd')}")
            print(f"Summary SHA-256: {summary.get('integrity', {}).get('summary_sha256')}")

        return EXIT_OK

    def cmd_export(self, run_id: str, format_type: str, output_path: str) -> int:
        try:
            summary = self.storage.read_sanitized_summary(run_id)
        except Exception as e:
            sys.stderr.write(f"Error reading summary for export: {e}\n")
            return EXIT_STORAGE_ERROR

        out_path = Path(output_path).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        if format_type == "json":
            export_content = json.dumps(summary, indent=2, sort_keys=True)
        elif format_type == "zuno-pr-record-fragment":
            fragment = {
                "schema_version": "zuno-pr-record-fragment-v1",
                "run_id": summary.get("run_id"),
                "work_package": summary.get("work_package"),
                "pr_number": summary.get("pr_number"),
                "telemetry": {
                    "agent_shell": summary.get("agent", {}).get("shell"),
                    "provider": summary.get("agent", {}).get("provider"),
                    "observed_model": summary.get("agent", {}).get("observed_model"),
                    "model_confidence": summary.get("agent", {}).get("model_detection_confidence"),
                    "started_at": summary.get("timing", {}).get("started_at"),
                    "finished_at": summary.get("timing", {}).get("finished_at"),
                    "wall_clock_seconds": summary.get("timing", {}).get("wall_clock_seconds"),
                    "usage": summary.get("usage"),
                    "pricing": summary.get("pricing"),
                },
                "git_summary": {
                    "head_sha": summary.get("git", {}).get("final_head_sha"),
                    "clean": summary.get("git", {}).get("final_clean"),
                    "commit_count": summary.get("git", {}).get("commit_count"),
                },
                "integrity_sha256": summary.get("integrity", {}).get("summary_sha256"),
            }
            export_content = json.dumps(fragment, indent=2, sort_keys=True)
        else:
            sys.stderr.write(f"Unsupported format: {format_type}\n")
            return EXIT_INVALID_INPUT

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(export_content)

        print(f"Exported run {run_id} to {out_path} ({format_type})")
        return EXIT_OK

    def cmd_price(
        self,
        provider: str,
        model: str,
        input_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
    ) -> int:
        res = self.pricing_engine.calculate_cost(
            provider=provider,
            model_name=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=None,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
        )

        if res.status in ("PRICE_NOT_AVAILABLE", "UNVERIFIED"):
            print("PRICE_NOT_AVAILABLE")
            return EXIT_OK

        print(json.dumps(res.to_dict(), indent=2))
        return EXIT_OK

    def cmd_internal_scan_secrets(self, scan_path: str) -> int:
        target = Path(scan_path)
        if not target.exists():
            sys.stderr.write(f"Scan path does not exist: {scan_path}\n")
            return EXIT_INVALID_INPUT

        found_violations = []
        if target.is_file():
            files = [target]
        else:
            files = list(target.rglob("*"))

        for f in files:
            if not f.is_file() or ".git" in f.parts:
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
                secret_types = scan_text_for_secret_types(text)
                if secret_types:
                    found_violations.append((str(f), sorted(list(secret_types))))
            except Exception:
                continue

        if found_violations:
            for p, types in found_violations:
                sys.stderr.write(f"SECRET DETECTED in {p}: {','.join(types)}\n")
            return EXIT_INTEGRITY_ERROR

        print("SECRET_SCAN_PASSED")
        return EXIT_OK


def main():
    parser = argparse.ArgumentParser(description="Agent Metrics Collector CLI")
    parser.add_argument("--debug", action="store_true", help="Enable debug traceback logging")
    subparsers = parser.add_subparsers(dest="command")

    # Doctor
    doc_parser = subparsers.add_parser("doctor", help="Run environment diagnostic checks")
    doc_parser.add_argument("--json", action="store_true", help="Output result as JSON")

    # Start
    start_parser = subparsers.add_parser("start", help="Start a metrics tracking run")
    start_parser.add_argument("--agent-shell", required=True, help="Agent shell type (Claude-Code, Antigravity, etc.)")
    start_parser.add_argument("--provider", required=True, help="Provider name (DeepSeek, Google, Anthropic, etc.)")
    start_parser.add_argument("--configured-model", help="Configured model name")
    start_parser.add_argument("--work-package", default="", help="Work Package ID")
    start_parser.add_argument("--pr-number", type=int, help="PR number")
    start_parser.add_argument("--worktree", default="", help="Path to worktree")
    start_parser.add_argument("--session-id", help="Explicit session ID")
    start_parser.add_argument("--json", action="store_true", help="Output JSON")

    # Finish
    fin_parser = subparsers.add_parser("finish", help="Finish a metrics tracking run")
    fin_parser.add_argument("--run-id", required=True, help="UUID run ID")
    fin_parser.add_argument("--json", action="store_true", help="Output JSON")

    # Reconcile
    rec_parser = subparsers.add_parser("reconcile", help="Reconcile run with GitHub PR & CI status")
    rec_parser.add_argument("--run-id", required=True, help="UUID run ID")
    rec_parser.add_argument("--repository", help="GitHub repository (owner/repo)")
    rec_parser.add_argument("--pr-number", type=int, help="PR number")

    # Show
    show_parser = subparsers.add_parser("show", help="Show sanitized summary for run")
    show_parser.add_argument("--run-id", required=True, help="UUID run ID")
    show_parser.add_argument("--json", action="store_true", help="Output JSON")

    # Export
    exp_parser = subparsers.add_parser("export", help="Export sanitized summary fragment")
    exp_parser.add_argument("--run-id", required=True, help="UUID run ID")
    exp_parser.add_argument("--format", choices=["json", "zuno-pr-record-fragment"], default="json")
    exp_parser.add_argument("--output", required=True, help="Output file path")

    # Price
    pr_parser = subparsers.add_parser("price", help="Calculate API equivalent cost")
    pr_parser.add_argument("--provider", required=True)
    pr_parser.add_argument("--model", required=True)
    pr_parser.add_argument("--input-tokens", type=int, default=0)
    pr_parser.add_argument("--cache-read-tokens", type=int, default=0)
    pr_parser.add_argument("--cache-write-tokens", type=int, default=0)
    pr_parser.add_argument("--output-tokens", type=int, default=0)

    # Internal scan secrets
    scan_parser = subparsers.add_parser("internal-scan-secrets", help="Scan directory for secrets")
    scan_parser.add_argument("--path", required=True)

    args = parser.parse_args()

    handler = CLIHandler()

    try:
        if args.command == "doctor":
            sys.exit(handler.cmd_doctor(json_output=args.json))
        elif args.command == "start":
            sys.exit(
                handler.cmd_start(
                    agent_shell=args.agent_shell,
                    provider=args.provider,
                    configured_model=args.configured_model,
                    work_package=args.work_package,
                    pr_number=args.pr_number,
                    worktree=args.worktree,
                    session_id=args.session_id,
                    json_output=args.json,
                )
            )
        elif args.command == "finish":
            sys.exit(handler.cmd_finish(run_id=args.run_id, json_output=args.json))
        elif args.command == "reconcile":
            sys.exit(handler.cmd_reconcile(run_id=args.run_id, repository=args.repository, pr_number=args.pr_number))
        elif args.command == "show":
            sys.exit(handler.cmd_show(run_id=args.run_id, json_output=args.json))
        elif args.command == "export":
            sys.exit(handler.cmd_export(run_id=args.run_id, format_type=args.format, output_path=args.output))
        elif args.command == "price":
            sys.exit(
                handler.cmd_price(
                    provider=args.provider,
                    model=args.model,
                    input_tokens=args.input_tokens,
                    cache_read_tokens=args.cache_read_tokens,
                    cache_write_tokens=args.cache_write_tokens,
                    output_tokens=args.output_tokens,
                )
            )
        elif args.command == "internal-scan-secrets":
            sys.exit(handler.cmd_internal_scan_secrets(scan_path=args.path))
        else:
            parser.print_help()
            sys.exit(EXIT_INVALID_INPUT)

    except Exception as e:
        if args.debug:
            raise e
        else:
            sys.stderr.write(f"Error: {e}\n")
            sys.exit(EXIT_INVALID_INPUT)


if __name__ == "__main__":
    main()
