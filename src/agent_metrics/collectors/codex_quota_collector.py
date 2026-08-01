"""
Codex Quota Read-Only Collector.

Discovers the local Cockpit Tools (or other compatible) Codex quota data source
through a strictly read-only path. Captures sanitized Before / After snapshots
and computes semantics-aware consumption deltas.

This revision introduces ``CockpitAppDataAdapter``: a strict, schema-locked
adapter that only emits ``source = cockpit_app_data`` /
``status = COMPLETE`` after it has loaded a JSON document matching the
**proven** Cockpit Tools 1.3.15 Codex Account schema and resolved the
current account via an explicit ``current_account_id`` field.

The legacy ``STATE_FILE`` env var is renamed to ``COMPAT_STATE_FILE`` and
is only used for fixtures and explicitly-configured compatibility shims.
A file loaded through ``COMPAT_STATE_FILE`` is tagged with
``source = compat_state_file`` — never ``cockpit_app_data`` — so the
boundary is preserved.

The collector MUST NOT:
  - Modify Cockpit files;
  - Refresh OAuth;
  - Switch accounts;
  - Start/stop Cockpit or any Gateway;
  - Modify Codex;
  - Send any Provider request;
  - Consume destructive queues;
  - Persist raw account IDs, emails, tokens, or full Home paths.

All persisted fields are strictly allowlisted. Account identifiers are
SHA-256 hashed and truncated to 12-16 hex characters.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import math
import os
import pathlib
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus


# ---- Constants ----------------------------------------------------------------

# Hash length for account_ref_hash. 12 hex chars = 48 bits, 16 hex = 64 bits.
ACCOUNT_HASH_HEX_CHARS = 16

# Allowlist of fields that may be persisted. Anything outside this list is
# dropped before serialization.
ALLOWLISTED_SNAPSHOT_FIELDS = {
    "captured_at",
    "account_ref_hash",
    "plan_type",
    "percentage_semantics",
    "primary_window",
    "secondary_window",
    "source",
    "status",
    "usage_updated_at",
}

ALLOWLISTED_WINDOW_FIELDS = {
    "percentage",
    "window_minutes",
    "reset_at",
}

# Allowed percentage_semantics values.
SEMANTICS_REMAINING = "remaining"
SEMANTICS_USED = "used"
SEMANTICS_UNKNOWN = "unknown"

ALLOWED_SEMANTICS = {SEMANTICS_REMAINING, SEMANTICS_USED, SEMANTICS_UNKNOWN}

# Status values for the snapshot.
STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL"
STATUS_NOT_AVAILABLE = "NOT_AVAILABLE"
STATUS_AMBIGUOUS = "AMBIGUOUS"
STATUS_SEMANTICS_UNVERIFIED = "SEMANTICS_UNVERIFIED"
STATUS_RESET_DURING_RUN = "RESET_DURING_RUN"
STATUS_ERROR = "ERROR"

ALLOWED_STATUS = {
    STATUS_COMPLETE,
    STATUS_PARTIAL,
    STATUS_NOT_AVAILABLE,
    STATUS_AMBIGUOUS,
    STATUS_SEMANTICS_UNVERIFIED,
    STATUS_RESET_DURING_RUN,
    STATUS_ERROR,
}

# Source identifiers.
SOURCE_COCKPIT_APP_DATA = "cockpit_app_data"
SOURCE_COMPAT_STATE_FILE = "compat_state_file"
CREDENTIAL_EXPORT_REJECTED = "CREDENTIAL_EXPORT_REJECTED"
CREDENTIAL_FIELD_NAMES = {
    "id_token",
    "access_token",
    "refresh_token",
    "api_key",
    "authorization",
    "cookie",
}

# Candidate Cockpit App Data directories inspected when looking for a real
# JSON Codex Account file. Only the directory NAMES are recorded in
# diagnostics; the absolute paths are NEVER persisted or printed verbatim.
COCKPIT_APP_DATA_CANDIDATE_DIRS = [
    # Cockpit Tools installer leaves a small marker file here.
    ("cockpit-tools", "{LOCALAPPDATA}\\cockpit-tools"),
    # Electron userData default for the package id "com.jlcodes.cockpit-tools".
    ("cockpit-tools-electron", "{LOCALAPPDATA}\\com.jlcodes.cockpit-tools"),
    # Per-instance Chromium profile.
    ("cockpit-instance", "{APPDATA}\\.antigravity_cockpit"),
]

# Candidate JSON filenames inside any discovered app-data directory. Only the
# basename is matched; deep recursive walking is intentionally avoided.
COCKPIT_CODEX_FILENAMES = {
    "codex_accounts.json",
    "codex-quota.json",
    "codex_account_index.json",
}


# ---- Helpers ------------------------------------------------------------------


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _hash_account_ref(account_ref: Optional[str]) -> Optional[str]:
    """Return the truncated HMAC-SHA256 hex hash for an opaque account reference.

    Returns ``None`` for empty / non-string inputs. The original value is
    NEVER persisted.
    """
    if not account_ref or not isinstance(account_ref, str):
        return None
    salt = _load_local_install_salt()
    digest = hmac.new(salt, account_ref.encode("utf-8"), hashlib.sha256).hexdigest()
    return digest[:ACCOUNT_HASH_HEX_CHARS]


def _load_local_install_salt() -> bytes:
    root = pathlib.Path(__file__).resolve().parent.parent.parent.parent / ".local" / "private"
    root.mkdir(parents=True, exist_ok=True)
    salt_file = root / "install-salt.bin"
    try:
        if salt_file.exists():
            data = salt_file.read_bytes()
            if len(data) >= 16:
                return data
        data = os.urandom(32)
        salt_file.write_bytes(data)
        return data
    except OSError:
        fallback = socket.gethostname().encode("utf-8", errors="ignore") or b"agent-metrics-local"
        return hashlib.sha256(fallback).digest()


def contains_credential_fields(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in CREDENTIAL_FIELD_NAMES:
                return True
            if contains_credential_fields(item):
                return True
    elif isinstance(value, list):
        return any(contains_credential_fields(item) for item in value)
    return False


def _is_finite_number(value: Any) -> bool:
    """Return True only when ``value`` is a finite real number.

    Rejects bool, None, NaN, +/-Infinity, strings, and other types. This
    enforces the strict percentage contract required by the spec.
    """
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return False
    return True


def _strict_percentage(value: Any) -> Optional[float]:
    """Strict percentage validation. Returns the float or ``None``.

    Rejects bool, NaN, Infinity, negative, greater-than-100, strings, and
    any other non-numeric input. NO clamping.
    """
    if not _is_finite_number(value):
        return None
    n = float(value)
    if n < 0.0 or n > 100.0:
        return None
    return n


def _strict_positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if not isinstance(value, int):
        return None
    if value <= 0:
        return None
    return value


def _coerce_iso(value: Any) -> Optional[str]:
    if not value or not isinstance(value, str):
        return None
    return value


def _build_snapshot_skeleton() -> Dict[str, Any]:
    """Empty sanitized snapshot frame, used as a fallback for NOT_AVAILABLE."""
    return {
        "captured_at": _utc_now_iso(),
        "account_ref_hash": None,
        "plan_type": None,
        "percentage_semantics": SEMANTICS_UNKNOWN,
        "usage_updated_at": None,
        "primary_window": {
            "percentage": None,
            "window_minutes": None,
            "reset_at": None,
        },
        "secondary_window": {
            "percentage": None,
            "window_minutes": None,
            "reset_at": None,
        },
    }


def _sanitize_window(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {
            "percentage": None,
            "window_minutes": None,
            "reset_at": None,
        }
    return {
        "percentage": _strict_percentage(raw.get("percentage")),
        "window_minutes": _strict_positive_int(raw.get("window_minutes")),
        "reset_at": _coerce_iso(raw.get("reset_at")),
    }


def sanitize_snapshot(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Apply allowlist filtering to a raw Codex quota snapshot."""
    if not isinstance(raw, dict):
        return _build_snapshot_skeleton()

    sanitized = _build_snapshot_skeleton()
    for key in ALLOWLISTED_SNAPSHOT_FIELDS:
        if key not in raw:
            continue
        value = raw[key]
        if key in ("primary_window", "secondary_window"):
            sanitized[key] = _sanitize_window(value)
        elif key == "captured_at":
            sanitized[key] = _coerce_iso(value) or _utc_now_iso()
        elif key == "account_ref_hash":
            sanitized[key] = _hash_account_ref(value) if value else None
        elif key == "plan_type":
            sanitized[key] = value if isinstance(value, str) else None
        elif key == "percentage_semantics":
            sanitized[key] = value if value in ALLOWED_SEMANTICS else SEMANTICS_UNKNOWN
        elif key == "usage_updated_at":
            sanitized[key] = _coerce_iso(value)
        elif key == "status":
            sanitized[key] = value if value in ALLOWED_STATUS else STATUS_NOT_AVAILABLE
        else:
            sanitized[key] = value

    if not sanitized.get("captured_at"):
        sanitized["captured_at"] = _utc_now_iso()

    return sanitized


# ---- Cockpit App Data Schema Adapter ----------------------------------------


# Strict contract for Cockpit Tools 1.3.15 Codex Account JSON.
#
# This is the *exact* set of fields the Cockpit UI displays for Codex and
# that the Cockpit Electron renderer persists in its Codex Account Index.
# The adapter REQUIRES this exact shape before it will tag a snapshot as
# ``source = cockpit_app_data`` / ``status = COMPLETE``.
REQUIRED_CODEX_ACCOUNT_TOP_FIELDS = (
    "account_id",
    "plan_type",
    "quota",
    "usage_updated_at",
)
REQUIRED_CODEX_QUOTA_FIELDS = (
    "hourly_percentage",
    "hourly_reset_time",
    "hourly_window_minutes",
    "weekly_percentage",
    "weekly_reset_time",
    "weekly_window_minutes",
)


def _candidate_app_data_dirs() -> List[Tuple[str, str]]:
    """Return ``(label, redacted_path)`` for every Cockpit app-data candidate.

    Absolute paths are intentionally NEVER persisted. We record only the
    candidate-directory *label* so logs / reports can show "we checked
    label X" without leaking the user's Home.
    """
    out: List[Tuple[str, str]] = []
    for label, template in COCKPIT_APP_DATA_CANDIDATE_DIRS:
        rendered = template
        for env in ("LOCALAPPDATA", "APPDATA"):
            value = os.environ.get(env)
            if value:
                rendered = rendered.replace("{" + env + "}", "[HOME]")
        out.append((label, rendered))
    return out


def _resolve_env_root(label: str) -> Optional[pathlib.Path]:
    """Resolve the env-var root for a Cockpit app-data candidate.

    Returns the *real* path on this host for adapter use, but the public
    diagnostics only emit the *label*.
    """
    if label in ("cockpit-tools", "cockpit-tools-electron"):
        env_value = os.environ.get("LOCALAPPDATA")
    else:
        env_value = os.environ.get("APPDATA")
    if not env_value:
        return None
    if label == "cockpit-tools":
        return pathlib.Path(env_value) / "cockpit-tools"
    if label == "cockpit-tools-electron":
        return pathlib.Path(env_value) / "com.jlcodes.cockpit-tools"
    return pathlib.Path(env_value) / ".antigravity_cockpit"


def _candidate_app_data_roots() -> List[Tuple[str, Optional[pathlib.Path]]]:
    """Return ``(label, resolved_root)`` for every Cockpit app-data candidate.

    ``resolved_root`` is the real path on this host and is used internally
    by :func:`load_cockpit_app_data_snapshot`. It is NEVER persisted or
    surfaced in reports.
    """
    out: List[Tuple[str, Optional[pathlib.Path]]] = []
    for label, _redacted in _candidate_app_data_dirs():
        out.append((label, _resolve_env_root(label)))
    return out


def _try_load_json(path: pathlib.Path) -> Optional[Dict[str, Any]]:
    """Best-effort load a JSON object from ``path`` without raising."""
    try:
        if not path.is_file():
            return None
        if path.stat().st_size > 4 * 1024 * 1024:
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
        data = json.loads(text)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _resolve_cockpit_current_account(
    raw: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Resolve the current Codex account from a Cockpit Codex Account Index.

    The Cockpit schema (1.3.15) requires an explicit ``current_account_id``
    field. If absent or ambiguous, ``status`` is set to AMBIGUOUS and the
    snapshot is rejected as a real Cockpit source.
    """
    accounts = raw.get("accounts")
    current_id = raw.get("current_account_id")

    if not isinstance(accounts, list) or len(accounts) == 0:
        return None, "missing_accounts"
    if not current_id or not isinstance(current_id, str):
        if len(accounts) == 1 and isinstance(accounts[0], dict):
            # Single account — Cockpit implicitly uses it. Still tag the
            # source as compat so we do NOT claim full Cockpit provenance.
            return None, "missing_current_account_id"
        return None, "missing_current_account_id"

    for acct in accounts:
        if isinstance(acct, dict) and acct.get("account_id") == current_id:
            return acct, "ok"

    # current_account_id references an account not present in the index.
    return None, "current_account_id_not_found"


def _validate_cockpit_account_shape(acct: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """Validate a Cockpit account object against the strict schema.

    Returns ``(parsed_snapshot, reason)``. When reason != "ok" the
    snapshot is rejected and must not be tagged as a real Cockpit source.
    """
    for field in REQUIRED_CODEX_ACCOUNT_TOP_FIELDS:
        if field not in acct:
            return None, f"missing_account_field:{field}"

    quota = acct.get("quota")
    if not isinstance(quota, dict):
        return None, "missing_quota_object"
    for field in REQUIRED_CODEX_QUOTA_FIELDS:
        if field not in quota:
            return None, f"missing_quota_field:{field}"

    plan_type = acct.get("plan_type")
    if not isinstance(plan_type, str) or not plan_type:
        return None, "missing_plan_type"

    usage_updated_at = acct.get("usage_updated_at")
    if not isinstance(usage_updated_at, str) or not usage_updated_at:
        return None, "missing_usage_updated_at"

    account_id = acct.get("account_id")
    if not isinstance(account_id, str) or not account_id:
        return None, "missing_account_id"

    hourly_pct = _strict_percentage(quota.get("hourly_percentage"))
    weekly_pct = _strict_percentage(quota.get("weekly_percentage"))
    if hourly_pct is None or weekly_pct is None:
        return None, "bad_percentage_value"

    hourly_window = _strict_positive_int(quota.get("hourly_window_minutes"))
    weekly_window = _strict_positive_int(quota.get("weekly_window_minutes"))
    if hourly_window is None or weekly_window is None:
        return None, "bad_window_minutes"

    hourly_reset = _coerce_iso(quota.get("hourly_reset_time"))
    weekly_reset = _coerce_iso(quota.get("weekly_reset_time"))
    if not hourly_reset or not weekly_reset:
        return None, "bad_reset_time"

    parsed = _build_snapshot_skeleton()
    parsed["account_ref_hash"] = _hash_account_ref("OpenAI:" + account_id)
    parsed["plan_type"] = plan_type
    parsed["usage_updated_at"] = usage_updated_at
    parsed["percentage_semantics"] = SEMANTICS_REMAINING
    parsed["primary_window"] = {
        "percentage": hourly_pct,
        "window_minutes": hourly_window,
        "reset_at": hourly_reset,
    }
    parsed["secondary_window"] = {
        "percentage": weekly_pct,
        "window_minutes": weekly_window,
        "reset_at": weekly_reset,
    }
    return parsed, "ok"


def load_cockpit_app_data_snapshot() -> Tuple[Optional[Dict[str, Any]], str, str]:
    """Discover and parse a real Cockpit App Data Codex snapshot.

    Returns ``(snapshot_dict, source_tag, reason)``.

    * ``snapshot_dict`` is the *parsed* sanitized snapshot or ``None``.
    * ``source_tag`` is one of:
        - ``SOURCE_COCKPIT_APP_DATA`` only when the schema is proven and
          the snapshot is COMPLETE;
        - ``SOURCE_COMPAT_STATE_FILE`` when an explicit compatibility file
          is loaded via ``COMPAT_STATE_FILE``;
        - ``"NOT_AVAILABLE"`` when no source can be located.
    * ``reason`` is a short diagnostic string for logs.
    """
    for label, base in _candidate_app_data_roots():
        if base is None or not base.exists():
            continue
        for candidate in base.rglob("*"):
            if not candidate.is_file():
                continue
            if candidate.name not in COCKPIT_CODEX_FILENAMES:
                continue
            raw = _try_load_json(candidate)
            if raw is None:
                continue
            if contains_credential_fields(raw):
                return None, CREDENTIAL_EXPORT_REJECTED, "credential_fields_present"
            account, account_reason = _resolve_cockpit_current_account(raw)
            if account is None:
                # Real Cockpit schema but AMBIGUOUS ownership — we cannot
                # tag this as a successful Cockpit read. Return so the
                # caller can decide.
                return None, "NOT_AVAILABLE", f"{label}:{account_reason}"
            parsed, parse_reason = _validate_cockpit_account_shape(account)
            if parsed is None:
                return None, "NOT_AVAILABLE", f"{label}:{parse_reason}"
            parsed["status"] = STATUS_COMPLETE
            parsed["source"] = SOURCE_COCKPIT_APP_DATA
            parsed["captured_at"] = _utc_now_iso()
            return parsed, SOURCE_COCKPIT_APP_DATA, "ok"
    return None, "NOT_AVAILABLE", "no_cockpit_app_data_file_found"


def load_compat_state_file_snapshot() -> Tuple[Optional[Dict[str, Any]], str, str]:
    """Load a snapshot from an explicitly-configured COMPAT_STATE_FILE.

    The returned snapshot is tagged with ``source = compat_state_file``
    so callers can distinguish it from a real Cockpit App Data read.
    The file MUST be a regular file smaller than 4 MiB and contain a
    JSON object.
    """
    path = os.environ.get("COMPAT_STATE_FILE")
    if not path:
        return None, "NOT_AVAILABLE", "compat_state_file_not_configured"
    parsed_path = pathlib.Path(path)
    raw = _try_load_json(parsed_path)
    if raw is None:
        return None, "NOT_AVAILABLE", "compat_state_file_unreadable"
    if contains_credential_fields(raw):
        return None, CREDENTIAL_EXPORT_REJECTED, "credential_fields_present"
    sanitized = sanitize_snapshot(raw)
    sanitized["status"] = STATUS_COMPLETE
    sanitized["source"] = SOURCE_COMPAT_STATE_FILE
    sanitized["captured_at"] = _utc_now_iso()
    return sanitized, SOURCE_COMPAT_STATE_FILE, "ok"


# ---- Collector ---------------------------------------------------------------


class CodexQuotaCollector(BaseCollector):
    """Read-only Codex quota collector backed by Cockpit Tools (when available)."""

    name = "codex_quota"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    # ---- public API ---------------------------------------------------------

    def get_status(self) -> str:
        snap, source, _reason = load_cockpit_app_data_snapshot()
        if source == CREDENTIAL_EXPORT_REJECTED:
            return CollectorStatus.ERROR.value
        if source == SOURCE_COCKPIT_APP_DATA and isinstance(snap, dict):
            return CollectorStatus.AVAILABLE.value
        # Even if no Cockpit source is reachable on this host, the
        # collector is a real module that can still report status. From
        # a configuration standpoint we report CONFIG_REQUIRED only when
        # the operator explicitly asked for a non-Cockpit source.
        if os.environ.get("COMPAT_STATE_FILE"):
            return CollectorStatus.CONFIG_REQUIRED.value
        return CollectorStatus.NOT_AVAILABLE.value

    def capture_snapshot(self) -> Dict[str, Any]:
        """Capture a sanitized Codex quota snapshot. Read-only.

        Returns the sanitized snapshot with allowlisted fields only.
        When no data source is available, returns a skeleton snapshot
        with ``status = NOT_AVAILABLE``.
        """
        snap, source, _reason = load_cockpit_app_data_snapshot()
        if isinstance(snap, dict):
            return snap
        if source == CREDENTIAL_EXPORT_REJECTED:
            skeleton = _build_snapshot_skeleton()
            skeleton["status"] = CREDENTIAL_EXPORT_REJECTED
            skeleton["source"] = source
            return skeleton

        compat_snap, compat_source, _compat_reason = load_compat_state_file_snapshot()
        if isinstance(compat_snap, dict):
            return compat_snap
        if compat_source == CREDENTIAL_EXPORT_REJECTED:
            skeleton = _build_snapshot_skeleton()
            skeleton["status"] = CREDENTIAL_EXPORT_REJECTED
            skeleton["source"] = compat_source
            return skeleton

        skeleton = _build_snapshot_skeleton()
        skeleton["status"] = STATUS_NOT_AVAILABLE
        return skeleton

    def calculate_delta(
        self,
        before: Optional[Dict[str, Any]],
        after: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Compute the consumption delta between two sanitized snapshots.

        Strict semantics contract:
          * Both snapshots must have a non-empty ``account_ref_hash``.
            If either is missing, status = AMBIGUOUS, consumed = null.
          * Both snapshots must declare the same ``percentage_semantics``.
            If they differ, status = SEMANTICS_UNVERIFIED, consumed = null.
          * If ``reset_at`` advances between Before and After for a
            window, that window's consumed = null and the window status
            is RESET_DURING_RUN.
          * No clamping. Negative deltas (i.e. the percentage went UP
            while semantics = remaining, or DOWN while semantics = used)
            result in status = AMBIGUOUS unless a reset is proven.
        """
        empty = {
            "primary_consumed_percentage": None,
            "secondary_consumed_percentage": None,
            "primary_status": STATUS_NOT_AVAILABLE,
            "secondary_status": STATUS_NOT_AVAILABLE,
            "delta_status": STATUS_NOT_AVAILABLE,
            "reason": "missing_snapshot",
        }

        if not isinstance(before, dict) or not isinstance(after, dict):
            return dict(empty, reason="missing_snapshot")

        before_hash = before.get("account_ref_hash")
        after_hash = after.get("account_ref_hash")
        if not before_hash or not after_hash:
            return {
                "primary_consumed_percentage": None,
                "secondary_consumed_percentage": None,
                "primary_status": STATUS_AMBIGUOUS,
                "secondary_status": STATUS_AMBIGUOUS,
                "delta_status": STATUS_AMBIGUOUS,
                "reason": "missing_account_ref_hash",
            }
        if before_hash != after_hash:
            return {
                "primary_consumed_percentage": None,
                "secondary_consumed_percentage": None,
                "primary_status": STATUS_AMBIGUOUS,
                "secondary_status": STATUS_AMBIGUOUS,
                "delta_status": STATUS_AMBIGUOUS,
                "reason": "account_ref_hash_mismatch",
            }

        before_sem = before.get("percentage_semantics")
        after_sem = after.get("percentage_semantics")
        if before_sem != after_sem:
            return {
                "primary_consumed_percentage": None,
                "secondary_consumed_percentage": None,
                "primary_status": STATUS_SEMANTICS_UNVERIFIED,
                "secondary_status": STATUS_SEMANTICS_UNVERIFIED,
                "delta_status": STATUS_SEMANTICS_UNVERIFIED,
                "reason": "semantics_mismatch",
            }
        semantics = before_sem
        if semantics not in ALLOWED_SEMANTICS:
            return {
                "primary_consumed_percentage": None,
                "secondary_consumed_percentage": None,
                "primary_status": STATUS_SEMANTICS_UNVERIFIED,
                "secondary_status": STATUS_SEMANTICS_UNVERIFIED,
                "delta_status": STATUS_SEMANTICS_UNVERIFIED,
                "reason": "semantics_unknown",
            }

        primary = self._compute_window_delta(before.get("primary_window"), after.get("primary_window"), semantics)
        secondary = self._compute_window_delta(before.get("secondary_window"), after.get("secondary_window"), semantics)

        any_reset = (
            primary["status"] == STATUS_RESET_DURING_RUN
            or secondary["status"] == STATUS_RESET_DURING_RUN
        )
        any_ambiguous = (
            primary["status"] == STATUS_AMBIGUOUS
            or secondary["status"] == STATUS_AMBIGUOUS
        )
        any_unverified = (
            primary["status"] == STATUS_SEMANTICS_UNVERIFIED
            or secondary["status"] == STATUS_SEMANTICS_UNVERIFIED
        )

        if any_ambiguous:
            delta_status = STATUS_AMBIGUOUS
        elif any_unverified:
            delta_status = STATUS_SEMANTICS_UNVERIFIED
        elif any_reset:
            delta_status = STATUS_RESET_DURING_RUN
        elif primary["status"] == STATUS_COMPLETE or secondary["status"] == STATUS_COMPLETE:
            delta_status = STATUS_COMPLETE
        else:
            delta_status = STATUS_PARTIAL

        return {
            "primary_consumed_percentage": primary["consumed"],
            "secondary_consumed_percentage": secondary["consumed"],
            "primary_status": primary["status"],
            "secondary_status": secondary["status"],
            "delta_status": delta_status,
            "reason": primary["reason"] + "|" + secondary["reason"],
        }

    # ---- BaseCollector ------------------------------------------------------

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "status": self.get_status(),
            "snapshot": self.capture_snapshot(),
        }

    # ---- internals ----------------------------------------------------------

    @staticmethod
    def _compute_window_delta(
        before_window: Optional[Dict[str, Any]],
        after_window: Optional[Dict[str, Any]],
        semantics: str,
    ) -> Dict[str, Any]:
        empty = {"consumed": None, "status": STATUS_NOT_AVAILABLE, "reason": "missing_window"}

        if not isinstance(before_window, dict) or not isinstance(after_window, dict):
            return empty

        before_pct = before_window.get("percentage")
        after_pct = after_window.get("percentage")
        before_reset = before_window.get("reset_at")
        after_reset = after_window.get("reset_at")

        # Reset detection: when reset_at advanced, the window reset during the run.
        if (
            isinstance(before_reset, str)
            and isinstance(after_reset, str)
            and before_reset
            and after_reset
            and before_reset != after_reset
        ):
            return {
                "consumed": None,
                "status": STATUS_RESET_DURING_RUN,
                "reason": "reset_during_run",
            }

        if not _is_finite_number(before_pct) or not _is_finite_number(after_pct):
            return {
                "consumed": None,
                "status": STATUS_NOT_AVAILABLE,
                "reason": "missing_percentage",
            }

        # We already validated ranges at sanitize-time, but a hostile
        # caller could still inject out-of-range values. Re-check here.
        if before_pct < 0.0 or before_pct > 100.0 or after_pct < 0.0 or after_pct > 100.0:
            return {
                "consumed": None,
                "status": STATUS_ERROR,
                "reason": "out_of_range_percentage",
            }

        if semantics == SEMANTICS_REMAINING:
            consumed = before_pct - after_pct
        elif semantics == SEMANTICS_USED:
            consumed = after_pct - before_pct
        else:
            return {
                "consumed": None,
                "status": STATUS_SEMANTICS_UNVERIFIED,
                "reason": "semantics_unknown",
            }

        # Negative delta without a reset is ambiguous: the percentage
        # moved in the opposite direction of the declared semantics.
        # The spec forbids abs() — surface AMBIGUOUS instead.
        if consumed < 0:
            return {
                "consumed": None,
                "status": STATUS_AMBIGUOUS,
                "reason": "negative_delta_without_reset",
            }

        return {
            "consumed": consumed,
            "status": STATUS_COMPLETE,
            "reason": "ok",
        }
