"""PR-level aggregation for sanitized run summaries."""

import datetime
from typing import Any, Dict, List, Optional

from agent_metrics.storage import IntegrityError, StorageError, StorageManager


TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
)

OBSERVED_USAGE_STATUSES = {"COMPLETE", "PARTIAL"}


def _parse_dt(value: Any) -> Optional[datetime.datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.datetime.fromisoformat(value)
    except Exception:
        return None


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return None


def iter_sanitized_summaries(storage: StorageManager) -> List[Dict[str, Any]]:
    """Return all readable sanitized summaries under the storage base dir."""
    summaries: List[Dict[str, Any]] = []
    for run_dir in sorted(storage.base_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        try:
            summaries.append(storage.read_sanitized_summary(run_dir.name))
        except (IntegrityError, StorageError, ValueError):
            continue
    return summaries


def _matches_pr(summary: Dict[str, Any], pr_number: int, repository: Optional[str]) -> bool:
    direct_pr = summary.get("pr_number")
    github = summary.get("github") if isinstance(summary.get("github"), dict) else {}
    github_pr = github.get("pr_number") or github.get("number")
    if direct_pr != pr_number and github_pr != pr_number:
        return False

    if repository:
        summary_repo = summary.get("repository")
        github_repo = github.get("repository")
        if summary_repo and summary_repo != repository and github_repo and github_repo != repository:
            return False
        if summary_repo and summary_repo != repository and not github_repo:
            return False
        if github_repo and github_repo != repository and not summary_repo:
            return False

    return True


def _antigravity_quota_complete(summary: Dict[str, Any]) -> bool:
    provider_quota = summary.get("provider_quota")
    if not isinstance(provider_quota, dict):
        return False
    ag_quota = provider_quota.get("antigravity_quota")
    return isinstance(ag_quota, dict) and ag_quota.get("status") == "COMPLETE"


def build_pr_aggregate(
    storage: StorageManager,
    pr_number: int,
    repository: Optional[str] = None,
) -> Dict[str, Any]:
    if pr_number is None or not isinstance(pr_number, int) or pr_number <= 0:
        raise ValueError("pr_number must be a positive integer")

    matching = [
        s for s in iter_sanitized_summaries(storage)
        if _matches_pr(s, pr_number=pr_number, repository=repository)
    ]

    usage_totals = {field: 0 for field in TOKEN_FIELDS}
    pricing_total = 0.0
    calculated_cost_runs = 0
    token_observed_runs = 0
    complete_runs = 0
    partial_runs = 0
    not_available_runs = 0
    ambiguous_runs = 0
    quota_only_runs = 0
    unresolved_runs: List[Dict[str, Any]] = []
    run_refs: List[Dict[str, Any]] = []
    started_values: List[datetime.datetime] = []
    finished_values: List[datetime.datetime] = []
    agent_process_seconds_sum = 0.0
    model_event_span_seconds_sum = 0.0

    for summary in matching:
        run_id = summary.get("run_id")
        agent = summary.get("agent") if isinstance(summary.get("agent"), dict) else {}
        usage = summary.get("usage") if isinstance(summary.get("usage"), dict) else {}
        pricing = summary.get("pricing") if isinstance(summary.get("pricing"), dict) else {}
        timing = summary.get("timing") if isinstance(summary.get("timing"), dict) else {}
        status = usage.get("collection_status") or "NOT_AVAILABLE"
        shell = str(agent.get("shell") or "")
        provider = str(agent.get("provider") or "")

        started = _parse_dt(timing.get("started_at"))
        finished = _parse_dt(timing.get("finished_at"))
        if started:
            started_values.append(started)
        if finished:
            finished_values.append(finished)

        agent_process = _num(timing.get("agent_process_seconds"))
        if agent_process is not None:
            agent_process_seconds_sum += agent_process
        model_span = _num(timing.get("model_event_span_seconds"))
        if model_span is not None:
            model_event_span_seconds_sum += model_span

        if status == "COMPLETE":
            complete_runs += 1
        elif status == "PARTIAL":
            partial_runs += 1
        elif status == "AMBIGUOUS":
            ambiguous_runs += 1
        else:
            not_available_runs += 1

        if status in OBSERVED_USAGE_STATUSES:
            token_observed_runs += 1
            for field in TOKEN_FIELDS:
                value = usage.get(field)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    usage_totals[field] += value
        else:
            unresolved = {
                "run_id": run_id,
                "agent_shell": shell,
                "provider": provider,
                "usage_status": status,
                "correlation_confidence": usage.get("correlation_confidence"),
            }
            if shell.lower() == "antigravity" and _antigravity_quota_complete(summary):
                quota_only_runs += 1
                unresolved["quota_status"] = "COMPLETE"
                unresolved["quota_attribution"] = "EXCLUSIVE_SESSION_WINDOW_ASSUMED_BY_OPERATOR"
                unresolved["note"] = "Quota is account-scope metadata and is not converted to tokens."
            unresolved_runs.append(unresolved)

        if pricing.get("status") == "CALCULATED":
            cost = _num(pricing.get("api_equivalent_cost_usd"))
            if cost is not None:
                pricing_total += cost
                calculated_cost_runs += 1

        run_refs.append({
            "run_id": run_id,
            "work_package": summary.get("work_package"),
            "agent_shell": shell,
            "provider": provider,
            "usage_status": status,
            "pricing_status": pricing.get("status"),
        })

    pr_started = min(started_values).isoformat() if started_values else None
    pr_finished = max(finished_values).isoformat() if finished_values else None
    pr_wall = None
    if started_values and finished_values:
        pr_wall = max(0.0, (max(finished_values) - min(started_values)).total_seconds())

    return {
        "schema_version": "agent-metrics-pr-aggregate-v1",
        "scope": "PR",
        "pr_number": pr_number,
        "repository": repository,
        "runs_count": len(matching),
        "run_refs": run_refs,
        "usage_totals": usage_totals,
        "pricing_totals": {
            "currency": "USD",
            "api_equivalent_cost_usd": round(pricing_total, 8),
            "actual_billed_cost_usd": None,
            "calculated_cost_runs": calculated_cost_runs,
        },
        "timing": {
            "pr_started_at": pr_started,
            "pr_finished_at": pr_finished,
            "pr_wall_clock_seconds": pr_wall,
            "agent_process_seconds_sum": round(agent_process_seconds_sum, 6),
            "model_event_span_seconds_sum": round(model_event_span_seconds_sum, 6),
        },
        "coverage": {
            "complete_runs": complete_runs,
            "partial_runs": partial_runs,
            "not_available_runs": not_available_runs,
            "ambiguous_runs": ambiguous_runs,
            "token_observed_runs": token_observed_runs,
            "quota_only_runs": quota_only_runs,
        },
        "unresolved_runs": unresolved_runs,
        "warnings": [
            "Quota percentages and balance changes are not converted to token usage.",
            "Antigravity quota-only runs are included as account-scope context only.",
        ],
    }
