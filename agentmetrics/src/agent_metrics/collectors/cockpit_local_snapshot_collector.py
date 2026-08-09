"""Cockpit local quota snapshot adapters.

Read-only adapters for local Cockpit cache files. The implementation is schema
driven and does not import Cockpit source code, call OAuth flows, or mutate any
agent/Cockpit configuration.
"""

from __future__ import annotations

import datetime
import os
from pathlib import Path
from typing import Any, Dict, Optional

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.collectors.codex_quota_collector import (
    CREDENTIAL_EXPORT_REJECTED,
    SOURCE_COCKPIT_APP_DATA,
    STATUS_NOT_AVAILABLE,
    _build_snapshot_skeleton,
    _hash_account_ref,
    _strict_percentage,
    contains_credential_fields,
)
from agent_metrics.models import CollectorStatus


ALLOWLIST = {
    "provider",
    "account_ref_hash",
    "plan_type",
    "percentage_semantics",
    "primary_window",
    "secondary_window",
    "model_quotas",
    "remaining_fraction",
    "reset_at",
    "usage_updated_at",
    "captured_at",
    "source",
    "status",
}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _candidate_roots() -> list[Path]:
    roots = [Path.home() / ".antigravity_cockpit", Path.home() / ".codex"]
    for env in ("LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(env)
        if base:
            roots.append(Path(base) / "cockpit-tools")
            roots.append(Path(base) / "com.jlcodes.cockpit-tools")
    return roots


def _json_files(root: Path):
    if not root.exists():
        return
    for p in root.rglob("*.json"):
        try:
            if p.is_file() and p.stat().st_size <= 4 * 1024 * 1024:
                yield p
        except OSError:
            continue


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    import json
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _sanitize_model_quotas(value: Any) -> Optional[list[Dict[str, Any]]]:
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        if not isinstance(item, dict):
            continue
        model = item.get("model")
        pct = _strict_percentage(item.get("percentage"))
        remaining = item.get("remaining_fraction")
        if isinstance(remaining, bool) or not isinstance(remaining, (int, float)):
            remaining = None
        if isinstance(model, str):
            out.append({
                "model": model,
                "percentage": pct,
                "remaining_fraction": remaining,
                "reset_at": item.get("reset_at") if isinstance(item.get("reset_at"), str) else None,
            })
    return out


def cockpit_antigravity_quota_snapshot(raw: Dict[str, Any]) -> Dict[str, Any]:
    if contains_credential_fields(raw):
        snap = _build_snapshot_skeleton()
        snap["provider"] = "Google"
        snap["status"] = CREDENTIAL_EXPORT_REJECTED
        snap["source"] = CREDENTIAL_EXPORT_REJECTED
        return snap
    account_id = raw.get("account_id") or raw.get("current_account_id") or raw.get("account")
    quota = raw.get("quota") if isinstance(raw.get("quota"), dict) else raw
    snap = _build_snapshot_skeleton()
    snap.update({
        "provider": "Google",
        "account_ref_hash": _hash_account_ref("Google:" + account_id) if isinstance(account_id, str) else None,
        "plan_type": raw.get("plan_type") if isinstance(raw.get("plan_type"), str) else None,
        "percentage_semantics": raw.get("percentage_semantics") if raw.get("percentage_semantics") in ("remaining", "used", "unknown") else "unknown",
        "model_quotas": _sanitize_model_quotas(quota.get("model_quotas")),
        "remaining_fraction": quota.get("remaining_fraction") if isinstance(quota.get("remaining_fraction"), (int, float)) and not isinstance(quota.get("remaining_fraction"), bool) else None,
        "reset_at": quota.get("reset_at") if isinstance(quota.get("reset_at"), str) else None,
        "usage_updated_at": raw.get("usage_updated_at") if isinstance(raw.get("usage_updated_at"), str) else None,
        "captured_at": _now(),
        "source": SOURCE_COCKPIT_APP_DATA,
        "status": "COMPLETE" if account_id or quota.get("model_quotas") else STATUS_NOT_AVAILABLE,
    })
    return {k: v for k, v in snap.items() if k in ALLOWLIST}


class CockpitLocalSnapshotCollector(BaseCollector):
    name = "cockpit_local_snapshot"

    def get_status(self) -> str:
        return CollectorStatus.AVAILABLE.value if any(r.exists() for r in _candidate_roots()) else CollectorStatus.NOT_AVAILABLE.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        provider = ((run_context or {}).get("agent", {}) or {}).get("provider")
        if str(provider).lower() != "google":
            return {"status": CollectorStatus.NOT_AVAILABLE.value, "antigravity_quota": None}
        for root in _candidate_roots():
            for path in _json_files(root) or []:
                raw = _load_json(path)
                if not raw:
                    continue
                if "antigravity" not in path.name.lower() and raw.get("provider") != "Google":
                    continue
                snap = cockpit_antigravity_quota_snapshot(raw)
                return {"status": snap.get("status"), "antigravity_quota": snap}
        return {"status": CollectorStatus.NOT_AVAILABLE.value, "antigravity_quota": None}
