"""PR-level aggregation for sanitized run summaries."""

import datetime
from typing import Any, Dict, List, Optional, Tuple

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
    summaries, _skipped = load_sanitized_summaries_with_audit(storage)
    return summaries


def load_sanitized_summaries_with_audit(
    storage: StorageManager,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Return readable summaries and sanitized audit entries for unreadable runs."""
    summaries: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for run_dir in sorted(storage.base_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        if not (run_dir / "sanitized-summary.json").exists():
            continue
        try:
            summaries.append(storage.read_sanitized_summary(run_dir.name))
        except IntegrityError as e:
            skipped.append({
                "run_id": run_dir.name,
                "reason": "integrity_or_schema_error",
                "error_type": type(e).__name__,
            })
        except (StorageError, ValueError) as e:
            skipped.append({
                "run_id": run_dir.name,
                "reason": "unreadable_summary",
                "error_type": type(e).__name__,
            })
    return summaries, skipped


def _repository_identities(summary: Dict[str, Any]) -> List[str]:
    github = summary.get("github") if isinstance(summary.get("github"), dict) else {}
    values = []
    for value in (summary.get("repository"), github.get("repository")):
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    return values


def _matches_pr(
    summary: Dict[str, Any],
    pr_number: int,
    repository: Optional[str],
) -> Tuple[bool, Optional[str]]:
    direct_pr = summary.get("pr_number")
    github = summary.get("github") if isinstance(summary.get("github"), dict) else {}
    github_pr = github.get("pr_number") or github.get("number")
    if direct_pr != pr_number and github_pr != pr_number:
        return False, "pr_number_mismatch"

    if repository:
        identities = _repository_identities(summary)
        if not identities:
            return False, "repository_identity_missing"
        unique = set(identities)
        if len(unique) > 1:
            return False, "repository_identity_conflict"
        if next(iter(unique)) != repository:
            return False, "repository_identity_mismatch"

    return True, None


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

    summaries, skipped_unreadable_runs = load_sanitized_summaries_with_audit(storage)
    matching = []
    excluded_runs: List[Dict[str, Any]] = []
    for summary in summaries:
        matched, reason = _matches_pr(summary, pr_number=pr_number, repository=repository)
        if matched:
            matching.append(summary)
        elif reason != "pr_number_mismatch":
            excluded_runs.append({
                "run_id": summary.get("run_id"),
                "reason": reason,
            })

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
    subscription_totals: Dict[str, float] = {}
    subscription_records = 0
    subscription_plan_types: List[str] = []
    session_aggregates: Dict[str, Dict[str, Any]] = {}

    for summary in matching:
        run_id = summary.get("run_id")
        agent = summary.get("agent") if isinstance(summary.get("agent"), dict) else {}
        usage = summary.get("usage") if isinstance(summary.get("usage"), dict) else {}
        pricing = summary.get("pricing") if isinstance(summary.get("pricing"), dict) else {}
        timing = summary.get("timing") if isinstance(summary.get("timing"), dict) else {}
        status = usage.get("collection_status") or "NOT_AVAILABLE"
        shell = str(agent.get("shell") or "")
        provider = str(agent.get("provider") or "")
        fleet = summary.get("fleet") if isinstance(summary.get("fleet"), dict) else {}
        session_record = summary.get("session") if isinstance(summary.get("session"), dict) else {}
        session_id = (
            session_record.get("agent_session_id")
            or summary.get("session_id")
            or fleet.get("fleet_session_id")
            or run_id
        )
        turn_id = fleet.get("fleet_turn_id") or run_id

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
            session_entry = session_aggregates.setdefault(
                str(session_id),
                {"session_id": session_id, "turns_count": 0, "usage_totals": {field: 0 for field in TOKEN_FIELDS}, "agent_process_seconds": 0.0, "api_equivalent_cost_usd": 0.0},
            )
            session_entry["turns_count"] += 1
            for field in TOKEN_FIELDS:
                value = usage.get(field)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    session_entry["usage_totals"][field] += value
            if agent_process is not None:
                session_entry["agent_process_seconds"] += agent_process
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
                unresolved["quota_attribution"] = "NOT_PROVEN"
                unresolved["note"] = "Quota is account-scope metadata and is not converted to tokens."
            unresolved_runs.append(unresolved)

        if pricing.get("status") == "CALCULATED":
            cost = _num(pricing.get("api_equivalent_cost_usd"))
            if cost is not None:
                pricing_total += cost
                calculated_cost_runs += 1
                session_entry = session_aggregates.setdefault(
                    str(session_id),
                    {"session_id": session_id, "turns_count": 0, "usage_totals": {field: 0 for field in TOKEN_FIELDS}, "agent_process_seconds": 0.0, "api_equivalent_cost_usd": 0.0},
                )
                session_entry["api_equivalent_cost_usd"] += cost

        subscription = pricing.get("subscription")
        if isinstance(subscription, dict):
            amount = _num(subscription.get("amount"))
            currency = subscription.get("currency") or "USD"
            if amount is not None and isinstance(currency, str):
                subscription_totals[currency] = subscription_totals.get(currency, 0.0) + amount
                subscription_records += 1
                plan_type = subscription.get("plan_type")
                if isinstance(plan_type, str) and plan_type not in subscription_plan_types:
                    subscription_plan_types.append(plan_type)
                session_entry = session_aggregates.setdefault(
                    str(session_id),
                    {"session_id": session_id, "turns_count": 0, "usage_totals": {field: 0 for field in TOKEN_FIELDS}, "agent_process_seconds": 0.0, "api_equivalent_cost_usd": 0.0},
                )
                session_entry.setdefault("subscription_totals", {})[currency] = session_entry.setdefault("subscription_totals", {}).get(currency, 0.0) + amount

        run_refs.append({
            "run_id": run_id,
            "session_id": session_id,
            "turn_id": turn_id,
            "work_package": summary.get("work_package"),
            "agent_shell": shell,
            "provider": provider,
            "usage_status": status,
            "pricing_status": pricing.get("status"),
            "tokens": {field: usage.get(field) for field in TOKEN_FIELDS if usage.get(field) is not None},
            "agent_process_seconds": agent_process,
            "api_equivalent_cost_usd": _num(pricing.get("api_equivalent_cost_usd")),
            "subscription_cost": _num(subscription.get("amount")) if isinstance(subscription, dict) else None,
        })

    pr_started = min(started_values).isoformat() if started_values else None
    pr_finished = max(finished_values).isoformat() if finished_values else None
    pr_wall = None
    if started_values and finished_values:
        pr_wall = max(0.0, (max(finished_values) - min(started_values)).total_seconds())

    integrity_failed_count = len(skipped_unreadable_runs)
    aggregate_status = "PARTIAL" if skipped_unreadable_runs else "COMPLETE"
    warnings = [
        "Quota percentages and balance changes are not converted to token usage.",
        "Antigravity quota-only runs are included as account-scope context only.",
    ]
    if skipped_unreadable_runs:
        warnings.append("One or more unreadable run summaries were excluded from this aggregate.")

    return {
        "schema_version": "agent-metrics-pr-aggregate-v1",
        "scope": "PR",
        "aggregate_status": aggregate_status,
        "pr_number": pr_number,
        "repository": repository,
        "runs_count": len(matching),
        "excluded_run_count": len(excluded_runs),
        "excluded_runs": excluded_runs,
        "skipped_unreadable_run_count": len(skipped_unreadable_runs),
        "integrity_failed_run_count": integrity_failed_count,
        "skipped_unreadable_runs": skipped_unreadable_runs,
        "run_refs": run_refs,
        "usage_totals": usage_totals,
        "pricing_totals": {
            "currency": "USD",
            "api_equivalent_cost_usd": round(pricing_total, 8),
            "actual_billed_cost_usd": None,
            "calculated_cost_runs": calculated_cost_runs,
        },
        "subscription_totals": {
            "by_currency": {key: round(value, 8) for key, value in subscription_totals.items()},
            "records": subscription_records,
            "plan_types": subscription_plan_types,
        },
        "session_aggregates": [
            {
                **entry,
                "agent_process_seconds": round(entry.get("agent_process_seconds", 0.0), 6),
                "api_equivalent_cost_usd": round(entry.get("api_equivalent_cost_usd", 0.0), 8),
                "subscription_totals": {
                    key: round(value, 8)
                    for key, value in (entry.get("subscription_totals") or {}).items()
                },
            }
            for entry in session_aggregates.values()
        ],
        "turns": run_refs,
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
        "warnings": warnings,
    }
