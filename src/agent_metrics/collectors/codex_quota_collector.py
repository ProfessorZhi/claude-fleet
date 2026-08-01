"""
Codex Quota Read-Only Collector.

Discovers the local Cockpit Tools (or other compatible) Codex quota data source
through a strictly read-only path. Captures sanitized Before / After snapshots
and computes semantics-aware consumption deltas.

Allowed data sources (in priority order):
  1. Cockpit Tools HTTP management endpoint, ONLY when:
       - The base URL resolves to a local host (127.0.0.1 / localhost);
       - The endpoint URL was configured explicitly via COCKPIT_BASE_URL;
       - The endpoint name was configured explicitly via
         COCKPIT_CODEX_QUOTA_PATH (default: ``v0/management/codex/quota``);
       - HTTP probes succeed without sending destructive payloads.
  2. A read-only state file configured explicitly via
     COCKPIT_CODEX_STATE_FILE. The file MUST exist and be a regular file.
  3. Otherwise: NOT_AVAILABLE.

NO third-party dependencies. HTTP uses ``urllib.request``. JSON uses stdlib.
The collector MUST NOT:
  - Modify Cockpit files;
  - Refresh OAuth;
  - Switch accounts;
  - Start/stop Cockpit or any Gateway;
  - Modify Codex;
  - Send any Provider request;
  - Consume destructive queues.

All persisted fields are strictly allowlisted. Account identifiers are
SHA-256 hashed and truncated to 12-16 hex characters.

This module is intentionally small, fail-closed, and side-effect free.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus


# ---- Constants ----------------------------------------------------------------

# Path used when probing the local Cockpit management endpoint for Codex quota.
# This path is a CONVENTION; the collector only honors it when the URL has been
# explicitly configured by the operator via COCKPIT_BASE_URL. It is never
# guessed from process discovery.
DEFAULT_CODEX_QUOTA_PATH = "v0/management/codex/quota"

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
STATUS_AVAILABLE = "AVAILABLE"
STATUS_CONFIG_REQUIRED = "CONFIG_REQUIRED"

ALLOWED_STATUS = {
    STATUS_COMPLETE,
    STATUS_PARTIAL,
    STATUS_NOT_AVAILABLE,
    STATUS_AMBIGUOUS,
    STATUS_SEMANTICS_UNVERIFIED,
    STATUS_RESET_DURING_RUN,
    STATUS_ERROR,
}


# ---- Helpers ------------------------------------------------------------------


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _hash_account_ref(account_ref: Optional[str]) -> Optional[str]:
    """Return the truncated SHA-256 hex hash for an opaque account reference.

    Returns ``None`` for empty / non-string inputs. The original value is
    NEVER persisted.
    """
    if not account_ref or not isinstance(account_ref, str):
        return None
    digest = hashlib.sha256(account_ref.encode("utf-8")).hexdigest()
    return digest[:ACCOUNT_HASH_HEX_CHARS]


def _coerce_percentage(value: Any) -> Optional[float]:
    """Best-effort coercion of a JSON value to a percentage in ``[0.0, 100.0]``.

    Returns ``None`` when the value cannot be interpreted as a percentage.
    Values outside the range are clamped — the source of truth for the
    semantics lives elsewhere.
    """
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    # Clamp to a sane percentage range. We do not assume any semantics here.
    if n < 0.0:
        return 0.0
    if n > 100.0:
        return 100.0
    return n


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_iso(value: Any) -> Optional[str]:
    if not value or not isinstance(value, str):
        return None
    return value


def _is_local_host(hostname: str) -> bool:
    hostname = (hostname or "").lower()
    return hostname in ("127.0.0.1", "localhost", "::1")


def _check_port_listening(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _build_snapshot_skeleton() -> Dict[str, Any]:
    """Empty sanitized snapshot frame, used as a fallback for NOT_AVAILABLE."""
    return {
        "captured_at": _utc_now_iso(),
        "account_ref_hash": None,
        "plan_type": None,
        "percentage_semantics": SEMANTICS_UNKNOWN,
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
        "percentage": _coerce_percentage(raw.get("percentage")),
        "window_minutes": _coerce_int(raw.get("window_minutes")),
        "reset_at": _coerce_iso(raw.get("reset_at")),
    }


def sanitize_snapshot(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Apply allowlist filtering to a raw Codex quota snapshot.

    All fields outside :data:`ALLOWLISTED_SNAPSHOT_FIELDS` are dropped. Nested
    window objects are also filtered via :data:`ALLOWLISTED_WINDOW_FIELDS`.
    The output is suitable for persistence.
    """
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
        elif key == "status":
            sanitized[key] = value if value in ALLOWED_STATUS else STATUS_NOT_AVAILABLE
        else:
            sanitized[key] = value

    if "captured_at" not in raw or not sanitized.get("captured_at"):
        sanitized["captured_at"] = _utc_now_iso()

    return sanitized


# ---- Source discovery --------------------------------------------------------


def _discover_via_cockpit_endpoint() -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Attempt read-only access via the Cockpit Tools management endpoint.

    Honors ``COCKPIT_BASE_URL`` and ``COCKPIT_CODEX_QUOTA_PATH`` env vars.
    The probe is a plain GET with a strict 2 s timeout. No management key is
    sent by default; only when ``COCKPIT_MANAGEMENT_KEY`` is provided.
    """
    base_url = os.environ.get("COCKPIT_BASE_URL")
    if not base_url:
        return False, None

    try:
        parsed = urllib.parse.urlparse(base_url)
    except Exception:
        return False, None

    if not _is_local_host(parsed.hostname or ""):
        return False, None

    quota_path = os.environ.get("COCKPIT_CODEX_QUOTA_PATH") or DEFAULT_CODEX_QUOTA_PATH
    if quota_path.startswith("/"):
        quota_path = quota_path.lstrip("/")
    endpoint = f"{base_url.rstrip('/')}/{quota_path}"

    req = urllib.request.Request(endpoint, method="GET")
    mgmt_key = os.environ.get("COCKPIT_MANAGEMENT_KEY")
    if mgmt_key:
        req.add_header("X-Management-Key", mgmt_key)

    try:
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            if resp.status != 200:
                return False, None
            data = json.loads(resp.read().decode("utf-8"))
            if not isinstance(data, dict):
                return False, None
            return True, data
    except (urllib.error.URLError, socket.timeout, json.JSONDecodeError, OSError):
        return False, None
    except Exception:
        return False, None


def _discover_via_state_file() -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Attempt read-only access via an explicitly configured state file.

    Honors ``COCKPIT_CODEX_STATE_FILE``. The file MUST be a regular file and
    contain valid JSON. Files larger than 4 MiB are rejected to avoid loading
    unrelated datasets.
    """
    path = os.environ.get("COCKPIT_CODEX_STATE_FILE")
    if not path:
        return False, None

    try:
        import pathlib
        p = pathlib.Path(path)
        if not p.is_file():
            return False, None
        if p.stat().st_size > 4 * 1024 * 1024:
            return False, None
        text = p.read_text(encoding="utf-8", errors="replace")
        data = json.loads(text)
        if not isinstance(data, dict):
            return False, None
        return True, data
    except (OSError, json.JSONDecodeError):
        return False, None


def discover_source() -> Dict[str, Any]:
    """Discover a Codex quota data source. Returns a discovery report.

    The result is a small dictionary suitable for diagnostics. It records
    which source path was used (or NOT_AVAILABLE) and the underlying
    evidence, while never leaking any field from the raw payload.
    """
    ok_http, _ = _discover_via_cockpit_endpoint()
    if ok_http:
        return {
            "source_type": "cockpit_codex",
            "source_path_type": "LOCAL_API",
            "available": True,
            "evidence": "COCKPIT_BASE_URL configured and Codex quota endpoint responded",
        }

    ok_file, _ = _discover_via_state_file()
    if ok_file:
        return {
            "source_type": "cockpit_codex",
            "source_path_type": "STATE_FILE",
            "available": True,
            "evidence": "COCKPIT_CODEX_STATE_FILE configured and parses as JSON object",
        }

    # Best-effort port probe for diagnostics. The collector never auto-binds
    # to a guessed port; this only records whether anything is listening.
    port_listening = False
    for host in ("127.0.0.1", "localhost"):
        if _check_port_listening(host, 19528, timeout=0.5):
            port_listening = True
            break

    return {
        "source_type": "cockpit_codex",
        "source_path_type": "NOT_AVAILABLE",
        "available": False,
        "evidence": (
            "COCKPIT_BASE_URL not configured or unreachable; "
            "COCKPIT_CODEX_STATE_FILE not configured or unreadable"
        ),
        "port_19528_listening": port_listening,
    }


# ---- Collector ---------------------------------------------------------------


class CodexQuotaCollector(BaseCollector):
    """Read-only Codex quota collector backed by Cockpit Tools (when available)."""

    name = "codex_quota"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    # ---- public API ---------------------------------------------------------

    def get_status(self) -> str:
        discovery = discover_source()
        if discovery.get("available"):
            return CollectorStatus.AVAILABLE.value
        # CONFIG_REQUIRED is reported only when COCKPIT_BASE_URL is set but the
        # endpoint is unreachable. Otherwise NOT_AVAILABLE.
        if os.environ.get("COCKPIT_BASE_URL"):
            return CollectorStatus.CONFIG_REQUIRED.value
        return CollectorStatus.NOT_AVAILABLE.value

    def capture_snapshot(self) -> Dict[str, Any]:
        """Capture a sanitized Codex quota snapshot. Read-only.

        Returns a sanitized snapshot with allowlisted fields only. If no data
        source is available, returns a skeleton snapshot with
        ``status = NOT_AVAILABLE``.
        """
        ok_http, raw_http = _discover_via_cockpit_endpoint()
        ok_file, raw_file = (False, None)
        if not ok_http:
            ok_file, raw_file = _discover_via_state_file()

        if not (ok_http or ok_file):
            skeleton = _build_snapshot_skeleton()
            skeleton["status"] = STATUS_NOT_AVAILABLE
            return skeleton

        raw = raw_http if ok_http else raw_file
        # Source identifier never persists the raw path or URL.
        sanitized = sanitize_snapshot(raw)
        sanitized["status"] = STATUS_COMPLETE
        sanitized["captured_at"] = _utc_now_iso()
        return sanitized

    def calculate_delta(
        self,
        before: Optional[Dict[str, Any]],
        after: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Compute the consumption delta between two sanitized snapshots.

        Honors percentage semantics. Returns a small dictionary:

            {
                "primary_consumed_percentage": float | None,
                "secondary_consumed_percentage": float | None,
                "primary_status": str,
                "secondary_status": str,
                "delta_status": str,
                "reason": str,
            }

        Rules:
          - semantics == remaining:
                consumed = before.percentage - after.percentage
          - semantics == used:
                consumed = after.percentage - before.percentage
          - semantics == unknown:
                consumed = None
          - account_ref_hash mismatch:
                status = AMBIGUOUS, both consumed = None
          - reset_at occurred during run:
                consumed = None, status = RESET_DURING_RUN
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
        if before_hash and after_hash and before_hash != after_hash:
            return {
                "primary_consumed_percentage": None,
                "secondary_consumed_percentage": None,
                "primary_status": STATUS_AMBIGUOUS,
                "secondary_status": STATUS_AMBIGUOUS,
                "delta_status": STATUS_AMBIGUOUS,
                "reason": "account_ref_hash_mismatch",
            }

        semantics = before.get("percentage_semantics") or SEMANTICS_UNKNOWN
        if semantics not in ALLOWED_SEMANTICS:
            semantics = SEMANTICS_UNKNOWN

        if semantics == SEMANTICS_UNKNOWN:
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

        if any_reset:
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
            "discovery": discover_source(),
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

        before_pct = _coerce_percentage(before_window.get("percentage"))
        after_pct = _coerce_percentage(after_window.get("percentage"))
        before_reset = _coerce_iso(before_window.get("reset_at"))
        after_reset = _coerce_iso(after_window.get("reset_at"))

        # Reset detection: when reset_at advanced, the window reset during the run.
        if before_reset and after_reset and after_reset != before_reset:
            return {
                "consumed": None,
                "status": STATUS_RESET_DURING_RUN,
                "reason": "reset_during_run",
            }

        if before_pct is None or after_pct is None:
            return {
                "consumed": None,
                "status": STATUS_NOT_AVAILABLE,
                "reason": "missing_percentage",
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

        return {
            "consumed": consumed,
            "status": STATUS_COMPLETE,
            "reason": "ok",
        }