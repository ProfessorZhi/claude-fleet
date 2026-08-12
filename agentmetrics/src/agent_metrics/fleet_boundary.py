"""Pure projection from an agentmetrics summary to a Fleet UsageRecord.

This module is deliberately a small, side-effect-free boundary.  It does not
launch an agent, read provider state, or send data anywhere.  The caller must
provide the Fleet instance id because ``fleet_worker_id`` is a correlation
identifier, not proof that every controller uses the same identifier.

The projection is intentionally fail-closed: a summary without observed usage
cannot become a fabricated Fleet UsageRecord.  Quota snapshots are kept in
the sanitized summary and are never folded into token counts or duration.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Dict, Mapping, Optional

from agent_metrics.validators import validate_sanitized_summary


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class FleetBoundaryError(ValueError):
    """Raised when a summary cannot be represented as a trustworthy record."""


def usage_record_from_summary(
    summary: Mapping[str, Any],
    *,
    usage_id: str,
    instance_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a secret-free Fleet ``UsageRecord``-shaped dictionary.

    ``usage_id`` and ``instance_id`` are supplied by the Fleet side.  When the
    latter is omitted, the Fleet worker id is used as the deterministic
    instance identity for the test/integration boundary.
    """

    summary_dict = dict(summary)
    try:
        validate_sanitized_summary(summary_dict)
    except ValueError as exc:
        raise FleetBoundaryError(str(exc)) from exc

    if not _SAFE_ID.fullmatch(usage_id):
        raise FleetBoundaryError("usage_id must be a safe non-empty identifier")

    fleet = summary_dict.get("fleet") or {}
    resolved_instance_id = instance_id or fleet.get("fleet_worker_id")
    if not isinstance(resolved_instance_id, str) or not _SAFE_ID.fullmatch(resolved_instance_id):
        raise FleetBoundaryError("instance_id or fleet_worker_id is required")

    usage = summary_dict["usage"]
    collection_status = usage.get("collection_status")
    if collection_status not in ("COMPLETE", "PARTIAL"):
        raise FleetBoundaryError(
            "UsageRecord requires observed usage; "
            f"collection_status={collection_status!r} is not publishable"
        )

    timing = summary_dict["timing"]
    captured_at = _timestamp_ms(
        timing.get("finished_at") or timing.get("started_at"),
        field="timing.finished_at/started_at",
    )

    tokens: Dict[str, int] = {}
    for source_key, target_key in (
        ("input_tokens", "inputTokens"),
        ("cache_read_tokens", "cachedInputTokens"),
        ("output_tokens", "outputTokens"),
        ("total_tokens", "totalTokens"),
    ):
        value = usage.get(source_key)
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise FleetBoundaryError(f"usage.{source_key} must be a non-negative integer")
            tokens[target_key] = value

    agent = summary_dict["agent"]
    session = summary_dict.get("session")
    session_id = session.get("agent_session_id") if isinstance(session, dict) else None
    turn_id = fleet.get("fleet_turn_id") or summary_dict.get("run_id")
    duration_ms = _duration_ms(timing.get("agent_process_seconds"))
    cost, cost_is_estimate = _cost_from_summary(summary_dict)
    costs = _costs_from_summary(summary_dict)
    quota_impact = _quota_impact_from_summary(summary_dict)

    record: Dict[str, Any] = {
        "usageId": usage_id,
        "instanceId": resolved_instance_id,
        "capturedAt": captured_at,
        "tokens": tokens,
        "source": "agentmetrics",
        "availability": "available" if collection_status == "COMPLETE" else "partial",
        "confidence": _confidence(usage.get("correlation_confidence")),
        "estimateOrActual": "estimate" if cost_is_estimate else "actual",
    }
    if session_id:
        record["sessionId"] = session_id
    if isinstance(turn_id, str) and _SAFE_ID.fullmatch(turn_id):
        record["turnId"] = turn_id
        record["aggregation"] = "turn"
    if fleet.get("fleet_task_id"):
        record["workItemId"] = fleet["fleet_task_id"]
    if agent.get("provider"):
        record["providerDisplayName"] = agent["provider"]
    model_id = agent.get("observed_model") or agent.get("configured_model") or agent.get("requested_model")
    if model_id:
        record["modelId"] = model_id
    runtime = _runtime_name(agent.get("shell"))
    if runtime:
        record["runtime"] = runtime
    if duration_ms is not None:
        record["durationMs"] = duration_ms
    if cost is not None:
        record["cost"] = cost
    if costs is not None:
        record["costs"] = costs
    if quota_impact is not None:
        record["quotaImpact"] = quota_impact
    return record


def _timestamp_ms(value: Any, *, field: str) -> int:
    if not isinstance(value, str):
        raise FleetBoundaryError(f"{field} must be an ISO timestamp")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FleetBoundaryError(f"{field} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp() * 1000)


def _duration_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise FleetBoundaryError("timing.agent_process_seconds must be non-negative")
    return int(round(float(value) * 1000))


def _confidence(value: Any) -> str:
    if value == "EXACT_SESSION_AND_CURSOR":
        return "exact"
    if value in ("EXACT_SESSION", "EXACT_RUN_ID", "EXACT_WORKTREE", "EXACT_PROCESS"):
        return "high"
    if value in ("TIME_WINDOW_MATCH",):
        return "medium"
    if value in ("AMBIGUOUS",):
        return "low"
    return "unknown"


def _runtime_name(shell: Any) -> Optional[str]:
    if not isinstance(shell, str) or not shell.strip():
        return None
    normalized = shell.strip().lower()
    if normalized in {"codex", "codex-cli", "openai-codex"}:
        return "codex-cli"
    if normalized in {"claude", "claude-code", "claudecode"}:
        return "claude-code"
    return normalized


def _cost_from_summary(summary: Mapping[str, Any]) -> tuple[Optional[Dict[str, Any]], bool]:
    pricing = summary.get("pricing") or {}
    currency = pricing.get("currency") or "USD"
    if not isinstance(currency, str) or not currency.strip() or len(currency) > 16:
        raise FleetBoundaryError("pricing.currency must be bounded text")
    actual = pricing.get("actual_billed_cost_usd")
    if _non_negative_number(actual):
        return ({"amount": float(actual), "currency": currency, "basis": "metered"}, False)
    equivalent = pricing.get("api_equivalent_cost_usd")
    if pricing.get("status") == "CALCULATED" and _non_negative_number(equivalent):
        return ({"amount": float(equivalent), "currency": currency, "basis": "api-equivalent"}, True)
    return (None, False)


def _costs_from_summary(summary: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    pricing = summary.get("pricing") or {}
    result: Dict[str, Any] = {}
    equivalent = pricing.get("api_equivalent_cost_usd")
    currency = pricing.get("currency") or "USD"
    if _non_negative_number(equivalent) and pricing.get("status") == "CALCULATED":
        result["apiEquivalent"] = {
            "amount": float(equivalent), "currency": currency, "basis": "api-equivalent"
        }
    actual = pricing.get("actual_billed_cost_usd")
    if _non_negative_number(actual):
        result["metered"] = {
            "amount": float(actual), "currency": currency, "basis": "metered"
        }
    subscription = pricing.get("subscription")
    if isinstance(subscription, dict):
        mapped = {
            "amount": subscription.get("amount"),
            "currency": subscription.get("currency") or currency,
            "basis": "subscription-amortized",
            "planType": subscription.get("plan_type"),
            "billingPeriod": subscription.get("billing_period"),
            "periodPrice": subscription.get("period_price"),
            "priceSource": subscription.get("price_source"),
            "fractionOfPeriod": subscription.get("fraction_of_period"),
            "consumedPercentage": subscription.get("consumed_percentage"),
            "resourceAccountId": subscription.get("resource_account_id"),
            "confidence": subscription.get("confidence"),
            "availability": subscription.get("availability"),
            "estimateOrActual": subscription.get("estimate_or_actual"),
        }
        if (
            _non_negative_number(mapped["amount"])
            and isinstance(mapped["billingPeriod"], str)
            and _non_negative_number(mapped["periodPrice"])
            and isinstance(mapped["priceSource"], str)
            and isinstance(mapped["fractionOfPeriod"], (int, float))
            and isinstance(mapped["consumedPercentage"], (int, float))
            and isinstance(mapped["confidence"], str)
            and isinstance(mapped["availability"], str)
            and isinstance(mapped["estimateOrActual"], str)
        ):
            result["subscription"] = mapped
    return result or None


def _quota_impact_from_summary(summary: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    quota = summary.get("quota") or {}
    delta = quota.get("delta") if isinstance(quota, dict) else None
    provider_quota = summary.get("provider_quota") or {}
    minimax = provider_quota.get("minimax_token_plan") if isinstance(provider_quota, dict) else None
    if not isinstance(delta, dict) and isinstance(minimax, dict):
        delta = minimax.get("delta")
        if isinstance(delta, dict):
            before = minimax.get("before") if isinstance(minimax.get("before"), dict) else None
            after = minimax.get("after") if isinstance(minimax.get("after"), dict) else None
            consumed = delta.get("consumed_percentage")
            if _non_negative_number(consumed):
                impact = {
                    "window": "custom",
                    "consumedPercentage": float(consumed),
                    "fractionOfWindow": float(consumed) / 100.0,
                    "source": "provider",
                    "availability": "available" if delta.get("status") == "COMPLETE" else "partial",
                    "confidence": "high" if delta.get("status") == "COMPLETE" else "medium",
                    "estimateOrActual": "actual",
                }
                snapshot = after or before or {}
                plan_type = snapshot.get("plan_type")
                if isinstance(plan_type, str) and plan_type:
                    impact["planType"] = plan_type
                return impact
    if not isinstance(delta, dict):
        return None
    consumed = delta.get("primary_consumed_percentage")
    before = quota.get("before") if isinstance(quota.get("before"), dict) else None
    after = quota.get("after") if isinstance(quota.get("after"), dict) else None
    if not _non_negative_number(consumed):
        consumed = delta.get("secondary_consumed_percentage")
        window_key = "secondary_window"
    else:
        window_key = "primary_window"
    if not _non_negative_number(consumed):
        return None
    window_minutes = ((after or before or {}).get(window_key) or {}).get("window_minutes")
    if isinstance(window_minutes, int) and window_minutes <= 360:
        window = "five-hour"
    elif isinstance(window_minutes, int) and window_minutes <= 10080:
        window = "weekly"
    else:
        window = "custom"
    snapshot = after or before or {}
    impact: Dict[str, Any] = {
        "window": window,
        "consumedPercentage": float(consumed),
        "fractionOfWindow": float(consumed) / 100.0,
        "source": "provider",
        "availability": "available" if delta.get("delta_status") == "COMPLETE" else "partial",
        "confidence": "high" if delta.get("delta_status") == "COMPLETE" else "medium",
        "estimateOrActual": "actual",
    }
    plan_type = snapshot.get("plan_type") or quota.get("subscription_tier")
    account = snapshot.get("account_ref_hash")
    if isinstance(plan_type, str) and plan_type:
        impact["planType"] = plan_type
    if isinstance(account, str) and _SAFE_ID.fullmatch(account):
        impact["resourceAccountId"] = account
    return impact


def _non_negative_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
