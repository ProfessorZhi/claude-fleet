"""
Standard library Contract Validator for agent_metrics.
Validates schemas without third-party dependencies.
"""

import re
from typing import Dict, Any, List

RE_RUN_ID = re.compile(r"^[a-zA-Z0-9_\-]+$")
RE_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
RE_COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{40}$")


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
    if status not in ("COMPLETE", "PARTIAL", "NOT_AVAILABLE"):
        raise ValueError(f"Invalid collection_status: {status!r}")

    out_tok = data.get("output_tokens")
    reas_tok = data.get("reasoning_tokens")
    if out_tok is not None and reas_tok is not None and reas_tok > out_tok:
        raise ValueError(f"Invalid usage: reasoning_tokens ({reas_tok}) cannot exceed output_tokens ({out_tok})")


def validate_pricing(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Pricing data must be a dictionary")

    status = data.get("status")
    if status not in ("CALCULATED", "UNVERIFIED", "PRICE_NOT_AVAILABLE", "INVALID_USAGE"):
        raise ValueError(f"Invalid pricing status: {status!r}")

    cost = data.get("api_equivalent_cost_usd")
    if cost is not None:
        if not isinstance(cost, (int, float)) or cost < 0:
            raise ValueError(f"api_equivalent_cost_usd must be non-negative numeric or null, got: {cost!r}")


def validate_run_context(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Run context must be a dictionary")

    req_fields = ["collector_version", "run_id", "started_at", "agent"]
    for f in req_fields:
        if f not in data or data[f] is None:
            raise ValueError(f"Missing required field in run context: '{f}'")

    validate_run_id(data["run_id"], "run_id")


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
