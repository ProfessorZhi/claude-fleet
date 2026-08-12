"""Build a safe Fleet telemetry envelope from an agentmetrics summary.

The module does not perform transport. It only creates the JSON shape accepted
by the server-side TelemetryIngestor. Account quota percentages are not
request usage; when a summary has no explicit Fleet quota measurement the
envelope carries an unavailable quota snapshot instead of an estimate.
"""

from __future__ import annotations

import datetime
from typing import Any, Dict, Mapping, Optional

from agent_metrics.fleet_boundary import FleetBoundaryError
from agent_metrics.fleet_collectors import telemetry_envelope_from_local_report
from agent_metrics.validators import validate_sanitized_summary


def telemetry_envelope_from_summary(
    summary: Mapping[str, Any],
    *,
    usage_id: str,
    instance_id: Optional[str] = None,
    quota_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Project a sanitized summary into the Fleet ingestion envelope.

    COMPLETE/PARTIAL usage becomes a UsageRecord-shaped object. A summary
    without publishable usage may still carry a quota observation, but that
    observation is explicitly unavailable unless a future adapter supplies a
    numeric Fleet QuotaSnapshot.
    """

    summary_dict = dict(summary)
    validate_sanitized_summary(summary_dict)
    status = (summary_dict.get("usage") or {}).get("collection_status")
    if status not in ("COMPLETE", "PARTIAL", "NOT_AVAILABLE", "AMBIGUOUS", "ERROR"):
        raise FleetBoundaryError(f"Unsupported usage collection status: {status!r}")
    return telemetry_envelope_from_local_report(
        summary_dict,
        usage_id=usage_id,
        instance_id=instance_id,
        quota_id=quota_id,
    )


def unavailable_quota_snapshot(
    summary: Mapping[str, Any],
    *,
    snapshot_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Return an explicit unavailable snapshot without interpreting percentages."""

    summary_dict = dict(summary)
    validate_sanitized_summary(summary_dict)
    run_id = summary_dict["run_id"]
    timing = summary_dict["timing"]
    captured_at = timing.get("finished_at") or timing.get("started_at")
    if not isinstance(captured_at, str):
        raise FleetBoundaryError("timing.finished_at/started_at must be an ISO timestamp")
    timestamp = _timestamp_ms(captured_at)
    agent = summary_dict.get("agent") or {}
    shell = str(agent.get("shell") or "").strip().lower()
    runtime = "codex-cli" if shell in {"codex", "codex-cli", "openai-codex"} else (
        "claude-code" if shell in {"claude", "claude-code", "claudecode"} else "other"
    )
    return {
        "snapshotId": snapshot_id or f"quota-{run_id}",
        "runtime": runtime,
        "window": "session",
        "capturedAt": timestamp,
        "source": "agentmetrics",
        "availability": "unavailable",
        "confidence": "unknown",
        "estimateOrActual": "actual",
    }


def _timestamp_ms(value: str) -> int:
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FleetBoundaryError("timestamp must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp() * 1000)
