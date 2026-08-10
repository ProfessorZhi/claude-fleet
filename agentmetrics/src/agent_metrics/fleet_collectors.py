"""Safe live-collector contract for local agentmetrics reports.

This module is deliberately transport-free.  It projects a sanitized local
report into four independent observations: usage, duration, cost, and quota.
The account quota section in an agentmetrics report is not task-attributable,
so it is always exposed as unavailable unless a future Fleet-specific source
provides an explicit numeric snapshot.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Dict, Mapping, Optional

from agent_metrics.fleet_boundary import FleetBoundaryError, usage_record_from_summary
from agent_metrics.validators import validate_sanitized_summary


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_AVAILABILITY = {"available", "partial", "unavailable"}
_CONFIDENCE = {"exact", "high", "medium", "low", "unknown"}


def collector_observations_from_summary(
    summary: Mapping[str, Any],
    *,
    usage_id: str,
    instance_id: Optional[str] = None,
    quota_id: Optional[str] = None,
) -> Dict[str, Dict[str, Any]]:
    """Return a strict, secret-free four-metric collector report.

    Every metric is present.  A collector that cannot prove a value returns
    ``availability=unavailable`` and omits ``value``; no zero or percentage is
    substituted.
    """

    summary_dict = dict(summary)
    validate_sanitized_summary(summary_dict)
    _require_safe_id(usage_id, "usage_id")
    if instance_id is not None:
        _require_safe_id(instance_id, "instance_id")

    captured_at = _summary_timestamp(summary_dict)
    usage_data = summary_dict.get("usage") or {}
    status = usage_data.get("collection_status")

    usage_record: Optional[Dict[str, Any]] = None
    if status in ("COMPLETE", "PARTIAL"):
        try:
            usage_record = usage_record_from_summary(
                summary_dict,
                usage_id=usage_id,
                instance_id=instance_id,
            )
        except FleetBoundaryError as exc:
            return _all_unavailable(captured_at, f"usage report is invalid: {exc}")

    observations: Dict[str, Dict[str, Any]] = {
        "usage": _observation(
            "usage",
            captured_at,
            "available" if status == "COMPLETE" else "partial" if status == "PARTIAL" else "unavailable",
            usage_record.get("tokens", {}) if usage_record is not None else None,
            "actual",
            _confidence(usage_data.get("correlation_confidence")),
            None if usage_record is not None else "provider usage is not available.",
        ),
        "duration": _duration_observation(summary_dict, captured_at),
        "cost": _cost_observation(summary_dict, captured_at),
        "quota": _unavailable_quota_observation(captured_at),
    }
    return observations


def telemetry_envelope_from_local_report(
    summary: Mapping[str, Any],
    *,
    usage_id: str,
    instance_id: Optional[str] = None,
    quota_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Adapt one sanitized local report to the server ingestion envelope.

    The envelope includes the proven usage record when token usage is
    publishable and always includes an explicit unavailable quota snapshot.
    Cost is attached only when it is explicitly metered or explicitly marked
    API-equivalent by the pricing collector.
    """

    envelope = {
        "quota": _unavailable_quota_snapshot(summary, quota_id),
        "idempotencyKey": f"agentmetrics-{summary['run_id']}",
    }
    observations = collector_observations_from_summary(
        summary,
        usage_id=usage_id,
        instance_id=instance_id,
        quota_id=quota_id,
    )
    usage_status = (summary.get("usage") or {}).get("collection_status")
    if usage_status in ("COMPLETE", "PARTIAL"):
        usage = usage_record_from_summary(summary, usage_id=usage_id, instance_id=instance_id)
        duration = observations["duration"].get("value")
        cost = observations["cost"].get("value")
        if duration is not None:
            usage["durationMs"] = duration
        if cost is not None:
            usage["cost"] = cost
            if observations["cost"]["estimateOrActual"] == "estimate":
                usage["estimateOrActual"] = "estimate"
        envelope["usage"] = usage
    return envelope


def _duration_observation(summary: Mapping[str, Any], captured_at: int) -> Dict[str, Any]:
    value = (summary.get("timing") or {}).get("agent_process_seconds")
    if value is None:
        return _observation("duration", captured_at, "unavailable", None, "actual", "unknown", "process duration is not available.")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return _observation("duration", captured_at, "unavailable", None, "actual", "unknown", "process duration is invalid.")
    return _observation("duration", captured_at, "available", int(round(float(value) * 1000)), "actual", "exact")


def _cost_observation(summary: Mapping[str, Any], captured_at: int) -> Dict[str, Any]:
    pricing = summary.get("pricing") or {}
    currency = pricing.get("currency") or "USD"
    actual = pricing.get("actual_billed_cost_usd")
    if _non_negative_number(actual):
        return _observation(
            "cost",
            captured_at,
            "available",
            {"amount": float(actual), "currency": currency, "basis": "metered"},
            "actual",
            "exact",
        )
    equivalent = pricing.get("api_equivalent_cost_usd")
    if pricing.get("status") == "CALCULATED" and _non_negative_number(equivalent):
        return _observation(
            "cost",
            captured_at,
            "available",
            {"amount": float(equivalent), "currency": currency, "basis": "api-equivalent"},
            "estimate",
            "high",
        )
    return _observation("cost", captured_at, "unavailable", None, "actual", "unknown", "cost is not available.")


def _unavailable_quota_observation(captured_at: int) -> Dict[str, Any]:
    return _observation(
        "quota",
        captured_at,
        "unavailable",
        None,
        "actual",
        "unknown",
        "account quota is not proven attributable to this Fleet work item.",
    )


def _all_unavailable(
    captured_at: int,
    reason: str,
) -> Dict[str, Dict[str, Any]]:
    return {
        kind: _observation(kind, captured_at, "unavailable", None, "actual", "unknown", reason)
        for kind in ("usage", "duration", "cost", "quota")
    }


def _observation(
    kind: str,
    captured_at: int,
    availability: str,
    value: Any,
    estimate_or_actual: str,
    confidence: str,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    if availability not in _AVAILABILITY:
        raise FleetBoundaryError(f"{kind} availability is invalid")
    if confidence not in _CONFIDENCE:
        raise FleetBoundaryError(f"{kind} confidence is invalid")
    result: Dict[str, Any] = {
        "kind": kind,
        "source": "agentmetrics",
        "availability": availability,
        "confidence": confidence,
        "estimateOrActual": estimate_or_actual,
        "capturedAt": captured_at,
    }
    if availability != "unavailable" and value is not None:
        result["value"] = value
    if reason:
        result["reason"] = " ".join(str(reason).split())[:256]
    return result


def _summary_timestamp(summary: Mapping[str, Any]) -> int:
    timing = summary.get("timing") or {}
    value = timing.get("finished_at") or timing.get("started_at")
    if not isinstance(value, str):
        raise FleetBoundaryError("timing.finished_at/started_at must be an ISO timestamp")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FleetBoundaryError("timestamp must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp() * 1000)


def _unavailable_quota_snapshot(summary: Mapping[str, Any], quota_id: Optional[str]) -> Dict[str, Any]:
    return {
        "snapshotId": quota_id or f"quota-{summary['run_id']}",
        "runtime": _runtime_name((summary.get("agent") or {}).get("shell")),
        "window": "session",
        "capturedAt": _summary_timestamp(summary),
        "source": "agentmetrics",
        "availability": "unavailable",
        "confidence": "unknown",
        "estimateOrActual": "actual",
    }


def _runtime_name(shell: Any) -> str:
    normalized = str(shell or "").strip().lower()
    if normalized in {"codex", "codex-cli", "openai-codex"}:
        return "codex-cli"
    if normalized in {"claude", "claude-code", "claudecode"}:
        return "claude-code"
    return "other"


def _confidence(value: Any) -> str:
    if value == "EXACT_SESSION_AND_CURSOR":
        return "exact"
    if value in {"EXACT_SESSION", "EXACT_RUN_ID", "EXACT_WORKTREE", "EXACT_PROCESS"}:
        return "high"
    if value == "TIME_WINDOW_MATCH":
        return "medium"
    if value == "AMBIGUOUS":
        return "low"
    return "unknown"


def _require_safe_id(value: str, field: str) -> None:
    if not isinstance(value, str) or not _SAFE_ID.fullmatch(value):
        raise FleetBoundaryError(f"{field} must be a safe non-empty identifier")


def _non_negative_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
