"""
Standard library Contract Validator for agent_metrics.
Validates schemas without third-party dependencies.
"""

import re
from typing import Dict, Any, List

RE_RUN_ID = re.compile(r"^[a-zA-Z0-9_\-]+$")
RE_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
RE_COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
RE_FLEET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

FLEET_ID_FIELDS = (
    "fleet_run_id",
    "fleet_task_id",
    "fleet_worker_id",
    "fleet_coordinator_id",
    "fleet_turn_id",
    "parent_worker_id",
    "worktree_id",
)


def validate_fleet_identity(data: Any, field_name: str = "fleet") -> None:
    """Validate secret-free Fleet correlation metadata.

    Fleet IDs are intentionally opaque, bounded identifiers. Paths, prompts,
    newlines, and arbitrary provider payloads do not belong in this object.
    """
    if data is None:
        return
    if not isinstance(data, dict):
        raise ValueError(f"Field '{field_name}' must be an object or null")

    allowed = set(FLEET_ID_FIELDS) | {"worker_role", "attempt"}
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValueError(f"Field '{field_name}' contains unsupported fields: {', '.join(unknown)}")

    for key in FLEET_ID_FIELDS + ("worker_role",):
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or not RE_FLEET_ID.fullmatch(value):
            raise ValueError(f"Field '{field_name}.{key}' must be a safe identifier")

    attempt = data.get("attempt")
    if attempt is not None and (not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1):
        raise ValueError(f"Field '{field_name}.attempt' must be a positive integer or null")


def validate_run_id(val: str, field_name: str) -> None:
    if not isinstance(val, str) or not RE_RUN_ID.match(val):
        raise ValueError(f"Field '{field_name}' must be a valid run ID string, got: {val!r}")


def validate_sha256(val: str, field_name: str) -> None:
    if not isinstance(val, str) or not RE_SHA256.match(val):
        raise ValueError(f"Field '{field_name}' must be a 64-character SHA-256 hex string, got: {val!r}")


def validate_non_negative_int(val: Any, field_name: str) -> None:
    if val is not None:
        if not isinstance(val, int) or isinstance(val, bool) or val < 0:
            raise ValueError(f"Field '{field_name}' must be a non-negative integer or null, got: {val!r}")


def validate_usage(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Usage data must be a dictionary")

    validate_non_negative_int(data.get("input_tokens"), "input_tokens")
    validate_non_negative_int(data.get("output_tokens"), "output_tokens")
    validate_non_negative_int(data.get("reasoning_tokens"), "reasoning_tokens")
    validate_non_negative_int(data.get("cache_read_tokens"), "cache_read_tokens")
    validate_non_negative_int(data.get("cache_write_tokens"), "cache_write_tokens")
    validate_non_negative_int(data.get("total_tokens"), "total_tokens")

    status = data.get("collection_status")
    if status not in ("COMPLETE", "PARTIAL", "NOT_AVAILABLE", "AMBIGUOUS", "ERROR"):
        raise ValueError(f"Invalid collection_status: {status!r}")

    out_tok = data.get("output_tokens")
    reas_tok = data.get("reasoning_tokens")
    if out_tok is not None and reas_tok is not None and reas_tok > out_tok:
        raise ValueError(f"Invalid usage: reasoning_tokens ({reas_tok}) cannot exceed output_tokens ({out_tok})")


def validate_pricing(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Pricing data must be a dictionary")

    status = data.get("status")
    if status not in ("CALCULATED", "UNVERIFIED", "PRICE_NOT_AVAILABLE", "INVALID_USAGE", "USAGE_NOT_AVAILABLE"):
        raise ValueError(f"Invalid pricing status: {status!r}")

    cost = data.get("api_equivalent_cost_usd")
    if cost is not None:
        if not isinstance(cost, (int, float)) or cost < 0:
            raise ValueError(f"api_equivalent_cost_usd must be non-negative numeric or null, got: {cost!r}")

    subscription = data.get("subscription")
    if subscription is not None:
        if not isinstance(subscription, dict):
            raise ValueError("pricing.subscription must be an object or null")
        allowed = {
            "amount", "currency", "basis", "plan_type", "billing_period",
            "period_price", "price_source", "fraction_of_period",
            "consumed_percentage", "resource_account_id", "confidence",
            "availability", "estimate_or_actual",
        }
        unknown = sorted(set(subscription) - allowed)
        if unknown:
            raise ValueError(f"pricing.subscription contains unsupported fields: {', '.join(unknown)}")
        amount = subscription.get("amount")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount < 0:
            raise ValueError("pricing.subscription.amount must be non-negative numeric")
        fraction = subscription.get("fraction_of_period")
        if not isinstance(fraction, (int, float)) or isinstance(fraction, bool) or not 0 <= fraction <= 1:
            raise ValueError("pricing.subscription.fraction_of_period must be between 0 and 1")
        percentage = subscription.get("consumed_percentage")
        if not isinstance(percentage, (int, float)) or isinstance(percentage, bool) or not 0 <= percentage <= 100:
            raise ValueError("pricing.subscription.consumed_percentage must be between 0 and 100")


def validate_run_context(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Run context must be a dictionary")

    req_fields = ["collector_version", "run_id", "started_at", "agent"]
    for f in req_fields:
        if f not in data or data[f] is None:
            raise ValueError(f"Missing required field in run context: '{f}'")

    validate_run_id(data["run_id"], "run_id")
    validate_fleet_identity(data.get("fleet"))


def validate_sanitized_summary(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Sanitized Summary must be a dictionary")

    req_top_fields = [
        "schema_version",
        "collector_version",
        "run_id",
        "work_package",
        "agent",
        "timing",
        "usage",
        "pricing",
        "quota",
        "git",
        "github",
        "collectors",
        "warnings",
        "integrity",
    ]
    for f in req_top_fields:
        if f not in data:
            raise ValueError(f"Missing required top-level field in summary: '{f}'")

    validate_run_id(data["run_id"], "run_id")
    validate_fleet_identity(data.get("fleet"))

    if not isinstance(data["agent"], dict) or "shell" not in data["agent"] or "provider" not in data["agent"]:
        raise ValueError("Summary 'agent' field must contain 'shell' and 'provider'")

    validate_usage(data["usage"])
    validate_pricing(data["pricing"])

    integrity = data["integrity"]
    if not isinstance(integrity, dict):
        raise ValueError("Summary 'integrity' field must be a dictionary")

    payload_sha = integrity.get("payload_sha256")
    if payload_sha is not None:
        validate_sha256(payload_sha, "payload_sha256")
