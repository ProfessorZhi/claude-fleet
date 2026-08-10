"""Provider balance/quota collectors.

These collectors never infer token usage from balance or quota. They only call
official balance endpoints when the operator explicitly provides the matching
environment variable.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus


class DeepSeekBalanceCollector(BaseCollector):
    name = "deepseek_balance"
    endpoint = "https://api.deepseek.com/user/balance"

    def get_status(self) -> str:
        return CollectorStatus.AVAILABLE.value if os.environ.get("DEEPSEEK_API_KEY") else CollectorStatus.CONFIG_REQUIRED.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        key = os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            return {"status": CollectorStatus.CONFIG_REQUIRED.value, "source": self.endpoint, "balance": None}
        req = urllib.request.Request(self.endpoint, method="GET")
        req.add_header("Authorization", "Bearer " + key)
        try:
            with _safe_open(req, self.endpoint) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
            mapped = _map_deepseek_balance(raw)
        except Exception:
            return {"status": CollectorStatus.ERROR.value, "source": self.endpoint, "balance": None}
        return {
            "status": CollectorStatus.AVAILABLE.value,
            "source": self.endpoint,
            "balance": mapped,
        }


class MiniMaxTokenPlanCollector(BaseCollector):
    name = "minimax_token_plan"
    endpoint = "https://www.minimax.io/v1/token_plan/remains"

    def get_status(self) -> str:
        return CollectorStatus.AVAILABLE.value if os.environ.get("MINIMAX_TOKEN_PLAN_KEY") else CollectorStatus.CONFIG_REQUIRED.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        key = os.environ.get("MINIMAX_TOKEN_PLAN_KEY")
        if not key:
            return {"status": CollectorStatus.CONFIG_REQUIRED.value, "source": self.endpoint, "balance": None}
        req = urllib.request.Request(self.endpoint, method="GET")
        req.add_header("Authorization", "Bearer " + key)
        try:
            with _safe_open(req, self.endpoint) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
            mapped = _sanitize_balance(raw)
            if not isinstance(mapped, dict) or not mapped:
                raise ValueError("unrecognized MiniMax token plan payload")
        except Exception:
            return {"status": CollectorStatus.ERROR.value, "source": self.endpoint, "balance": None}
        return {
            "status": CollectorStatus.AVAILABLE.value,
            "source": self.endpoint,
            "balance": mapped,
        }

    def capture_snapshot(self) -> Dict[str, Any]:
        result = self.collect()
        balance = result.get("balance") if isinstance(result, dict) else None
        if isinstance(balance, dict):
            return {**balance, "status": result.get("status"), "source": result.get("source")}
        return {
            "status": result.get("status", CollectorStatus.NOT_AVAILABLE.value),
            "source": result.get("source", self.endpoint),
        }

    def calculate_delta(
        self,
        before: Optional[Dict[str, Any]],
        after: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Accept only explicit provider percentage fields, never raw balances."""
        if not isinstance(before, dict) or not isinstance(after, dict):
            return {"consumed_percentage": None, "status": "NOT_AVAILABLE", "reason": "missing_snapshot"}
        for key in ("consumed_percentage", "usage_percentage", "used_percentage"):
            value = after.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 100:
                return {"consumed_percentage": float(value), "status": "COMPLETE", "reason": key}
        for key in ("remaining_percentage", "remain_percentage"):
            previous = before.get(key)
            current = after.get(key)
            if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (previous, current)):
                delta = float(previous) - float(current)
                if 0 <= delta <= 100:
                    return {"consumed_percentage": delta, "status": "COMPLETE", "reason": key}
        return {"consumed_percentage": None, "status": "NOT_AVAILABLE", "reason": "percentage_field_unavailable"}


class _NoCrossHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old_host = urllib.parse.urlparse(req.full_url).netloc.lower()
        new_host = urllib.parse.urlparse(newurl).netloc.lower()
        if old_host != new_host:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _safe_open(req: urllib.request.Request, endpoint: str):
    opener = urllib.request.build_opener(_NoCrossHostRedirect)
    return opener.open(req, timeout=10.0)


def _map_deepseek_balance(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("deepseek payload must be object")
    allowed = {
        "is_available",
        "currency",
        "total_balance",
        "granted_balance",
        "topped_up_balance",
    }
    source = raw.get("balance_infos")
    if isinstance(source, list) and source and isinstance(source[0], dict):
        source = source[0]
    elif not isinstance(source, dict):
        source = raw
    out = {k: source.get(k) for k in allowed if k in source}
    if not out:
        raise ValueError("unrecognized DeepSeek balance payload")
    import datetime
    out["captured_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return out


def _sanitize_balance(raw: Any) -> Any:
    if isinstance(raw, dict):
        out = {}
        for key, value in raw.items():
            lk = str(key).lower()
            if any(s in lk for s in ("token", "key", "secret", "authorization", "email", "user", "account_id")):
                if lk in ("token_plan", "token_plans", "total_tokens", "remaining_tokens"):
                    pass
                else:
                    continue
            if isinstance(value, (str, int, float, bool)) or value is None:
                out[key] = value
            elif isinstance(value, (dict, list)):
                out[key] = _sanitize_balance(value)
        return out
    if isinstance(raw, list):
        return [_sanitize_balance(item) for item in raw]
    if isinstance(raw, (str, int, float, bool)) or raw is None:
        return raw
    return None
