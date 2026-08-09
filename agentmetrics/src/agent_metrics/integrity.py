"""
Integrity module for calculating and verifying SHA-256 payload and file hashes.
"""

import json
import hashlib
from typing import Dict, Any, Tuple


def compute_payload_sha256(summary_dict: Dict[str, Any]) -> str:
    """
    Computes SHA-256 hash over canonical JSON of summary payload with integrity cleared.
    """
    cleaned = dict(summary_dict)
    # Remove integrity key for canonical calculation
    if "integrity" in cleaned:
        cleaned["integrity"] = {}

    canonical_json = json.dumps(cleaned, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def compute_file_sha256(file_bytes: bytes) -> str:
    """
    Computes SHA-256 hash over raw file bytes.
    """
    return hashlib.sha256(file_bytes).hexdigest()


def verify_summary_integrity(summary_dict: Dict[str, Any], raw_bytes: bytes, expected_file_sha: str) -> Tuple[bool, str]:
    """
    Verifies both payload_sha256 and file_sha256.
    Returns (is_valid, error_message).
    """
    # 1. Verify file_sha256
    actual_file_sha = compute_file_sha256(raw_bytes)
    if expected_file_sha and actual_file_sha != expected_file_sha.strip():
        return False, f"File SHA-256 mismatch: expected {expected_file_sha}, got {actual_file_sha}"

    # 2. Verify payload_sha256
    integrity_obj = summary_dict.get("integrity", {})
    expected_payload_sha = integrity_obj.get("payload_sha256")
    actual_payload_sha = compute_payload_sha256(summary_dict)

    if not expected_payload_sha:
        return False, "Missing payload_sha256 in summary integrity"

    if expected_payload_sha != actual_payload_sha:
        return False, f"Payload SHA-256 mismatch: expected {expected_payload_sha}, got {actual_payload_sha}"

    return True, ""
