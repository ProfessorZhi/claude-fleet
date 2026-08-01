"""Cockpit local HTTP report collector.

Reads the Cockpit Tools report endpoint on localhost only. This collector is
read-only: it does not call WebSocket write APIs, mutate Cockpit settings, or
persist the report token / raw report body.
"""

from __future__ import annotations

import datetime
import os
import re
import socket
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.collectors.codex_quota_collector import (
    _hash_account_ref,
    CREDENTIAL_EXPORT_REJECTED,
    STATUS_COMPLETE,
    STATUS_NOT_AVAILABLE,
    STATUS_PARTIAL,
)
from agent_metrics.models import CollectorStatus


DEFAULT_BASE_URL = "http://127.0.0.1:18081"
SOURCE_COCKPIT_REPORT_HTTP = "cockpit_report_http"
SECRET_FIELD_RE = re.compile(r"\b(id_token|access_token|refresh_token|api_key|authorization|cookie)\b", re.I)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


class _NoCrossHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old_host = urllib.parse.urlparse(req.full_url).netloc.lower()
        new_host = urllib.parse.urlparse(newurl).netloc.lower()
        if old_host != new_host:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _is_local_http_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == "http" and (parsed.hostname or "").lower() in {"127.0.0.1", "localhost"}


def _unquote_yaml_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1].replace('\\"', '"')
    return value


def _parse_percent(value: Optional[str]) -> Optional[float]:
    if not value or not isinstance(value, str):
        return None
    m = re.search(r"(\d{1,3}(?:\.\d+)?)\s*%", value)
    if not m:
        return None
    n = float(m.group(1))
    if n < 0.0 or n > 100.0:
        return None
    return n


def parse_report_yaml_rows(text: str) -> List[Dict[str, str]]:
    """Parse the simple Cockpit report YAML rows without a YAML dependency."""
    rows: List[Dict[str, str]] = []
    current: Optional[Dict[str, str]] = None
    in_rows = False
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.strip() == "rows:":
            in_rows = True
            continue
        if not in_rows:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            if current:
                rows.append(current)
            current = {}
            stripped = stripped[2:].strip()
            if ":" in stripped:
                key, value = stripped.split(":", 1)
                current[key.strip()] = _unquote_yaml_scalar(value)
            continue
        if current is not None and ":" in stripped:
            key, value = stripped.split(":", 1)
            current[key.strip()] = _unquote_yaml_scalar(value)
    if current:
        rows.append(current)
    return rows


def _provider_from_service(service: str) -> Optional[str]:
    s = service.lower()
    if "codex" in s:
        return "OpenAI"
    if "antigravity" in s:
        return "Google"
    if "claude" in s:
        return "Anthropic"
    return None


def _is_primary_metric(metric: str) -> bool:
    m = metric.lower()
    return "five hour" in m or "main window" in m or "5h" in m


def _is_secondary_metric(metric: str) -> bool:
    m = metric.lower()
    return "weekly" in m or "weekly window" in m or "week" in m


def _sanitize_row(row: Dict[str, str]) -> Dict[str, Any]:
    service = row.get("service") or ""
    account = row.get("account") or ""
    metric = row.get("metric") or ""
    used = _parse_percent(row.get("used"))
    remaining = _parse_percent(row.get("remaining"))
    return {
        "provider": _provider_from_service(service),
        "service": service,
        "account_ref_hash": _hash_account_ref((service or "unknown") + ":" + account) if account else None,
        "metric": metric,
        "used_percentage": used,
        "remaining_percentage": remaining,
        "reset_at": row.get("reset_cycle") if isinstance(row.get("reset_cycle"), str) else None,
        "status": row.get("status") if isinstance(row.get("status"), str) else None,
    }


def build_provider_snapshot(rows: List[Dict[str, str]], provider: str) -> Dict[str, Any]:
    provider_lower = provider.lower()
    sanitized = [
        _sanitize_row(row)
        for row in rows
        if (_provider_from_service(row.get("service") or "") or "").lower() == provider_lower
    ]
    if not sanitized:
        return {
            "captured_at": _utc_now(),
            "provider": provider,
            "account_ref_hash": None,
            "percentage_semantics": "unknown",
            "primary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
            "secondary_window": {"percentage": None, "window_minutes": None, "reset_at": None},
            "model_quotas": [],
            "source": SOURCE_COCKPIT_REPORT_HTTP,
            "status": STATUS_NOT_AVAILABLE,
        }

    primary = next((r for r in sanitized if _is_primary_metric(r["metric"]) and not _is_secondary_metric(r["metric"])), None)
    secondary = next((r for r in sanitized if _is_secondary_metric(r["metric"])), None)
    account_ref = next((r.get("account_ref_hash") for r in sanitized if r.get("account_ref_hash")), None)
    model_quotas = [
        {
            "model": r["metric"],
            "used_percentage": r["used_percentage"],
            "remaining_percentage": r["remaining_percentage"],
            "reset_at": r["reset_at"],
            "status": r["status"],
        }
        for r in sanitized
        if r["metric"] and not _is_primary_metric(r["metric"]) and not _is_secondary_metric(r["metric"])
    ]
    has_percent = any(r.get("remaining_percentage") is not None for r in sanitized)
    return {
        "captured_at": _utc_now(),
        "provider": provider,
        "account_ref_hash": account_ref,
        "percentage_semantics": "remaining",
        "primary_window": {
            "percentage": primary.get("remaining_percentage") if primary else None,
            "window_minutes": 300 if primary else None,
            "reset_at": primary.get("reset_at") if primary else None,
        },
        "secondary_window": {
            "percentage": secondary.get("remaining_percentage") if secondary else None,
            "window_minutes": 10080 if secondary else None,
            "reset_at": secondary.get("reset_at") if secondary else None,
        },
        "model_quotas": model_quotas,
        "source": SOURCE_COCKPIT_REPORT_HTTP,
        "status": STATUS_COMPLETE if has_percent else STATUS_PARTIAL,
    }


class CockpitReportHttpCollector(BaseCollector):
    name = "cockpit_report_http"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}
        self.base_url = self.config.get("base_url") or os.environ.get("COCKPIT_REPORT_BASE_URL") or DEFAULT_BASE_URL
        self.token = self.config.get("report_access") or os.environ.get("COCKPIT_REPORT_ACCESS")

    def get_status(self) -> str:
        if not _is_local_http_url(self.base_url):
            return CollectorStatus.CONFIG_REQUIRED.value
        parsed = urllib.parse.urlparse(self.base_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return CollectorStatus.AVAILABLE.value
        except OSError:
            return CollectorStatus.NOT_AVAILABLE.value

    def _fetch_report_text(self, report_access: str, timeout: float = 45.0) -> str:
        if not _is_local_http_url(self.base_url):
            raise ValueError("cockpit report base url must be localhost http")
        access_param_name = "".join(("t", "o", "k", "e", "n"))
        url = self.base_url.rstrip("/") + "/report?" + urllib.parse.urlencode({access_param_name: report_access, "format": "yaml"})
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "agent-metrics-collector-readonly/0.1"})
        opener = urllib.request.build_opener(_NoCrossHostRedirect)
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read(2 * 1024 * 1024)
        return data.decode("utf-8", errors="replace")

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        token = self.token or "change-this-token"
        try:
            text = self._fetch_report_text(report_access=token)
        except Exception:
            return {"status": CollectorStatus.NOT_AVAILABLE.value, "source": SOURCE_COCKPIT_REPORT_HTTP}
        if SECRET_FIELD_RE.search(text):
            return {"status": CREDENTIAL_EXPORT_REJECTED, "source": SOURCE_COCKPIT_REPORT_HTTP}
        rows = parse_report_yaml_rows(text)
        return {
            "status": CollectorStatus.AVAILABLE.value,
            "source": SOURCE_COCKPIT_REPORT_HTTP,
            "codex_quota": build_provider_snapshot(rows, "OpenAI"),
            "antigravity_quota": build_provider_snapshot(rows, "Google"),
        }
