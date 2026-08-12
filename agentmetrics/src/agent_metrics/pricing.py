"""
Pricing Engine for calculating API Equivalent Cost (USD).
Calculates equivalent provider list price.
Note:
- Input tokens, cache read tokens, cache write tokens, and output tokens are independent buckets.
- Reasoning tokens must be declared by Pricing Registry (reasoning_included_in_output).
- Unverified models return UNVERIFIED and null cost.
"""

import json
import os
from pathlib import Path
from typing import Dict, Any, Optional, List, Union

from agent_metrics.models import PricingInfo


class PricingEngine:
    def __init__(self, pricing_file: Optional[Path] = None):
        if not pricing_file:
            pricing_file = Path(__file__).resolve().parent.parent.parent / "config" / "model-pricing.json"
        self.pricing_file = Path(pricing_file)
        self.pricing_registry = self._load_registry()
        subscription_file = os.environ.get("AGENTMETRICS_SUBSCRIPTION_PRICING_FILE")
        if subscription_file:
            self.subscription_file = Path(subscription_file)
        else:
            self.subscription_file = self.pricing_file.parent / "subscription-pricing.json"
        self.subscription_registry = self._load_json(self.subscription_file)

    def _load_registry(self) -> Dict[str, Any]:
        return self._load_json(self.pricing_file)

    @staticmethod
    def _load_json(path: Path) -> Dict[str, Any]:
        if not path.exists():
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def calculate_subscription_cost(
        self,
        *,
        provider: Optional[str],
        plan_type: Optional[str],
        consumed_percentage: Optional[float],
        actual_price: Optional[float] = None,
        actual_currency: Optional[str] = None,
        amortization_period: str = "weekly",
    ) -> Optional[Dict[str, Any]]:
        """Allocate a quota delta to a subscription-equivalent amount.

        The result is explicitly an estimate unless the caller supplies an
        invoice/user price. It never turns missing quota into token usage.
        Monthly plans use four weeks for the user-facing weekly comparison;
        the divisor is recorded in the catalog contract rather than hidden.
        """
        if not provider or not plan_type or consumed_percentage is None:
            return None
        if isinstance(consumed_percentage, bool) or not 0 <= float(consumed_percentage) <= 100:
            return None
        normalized_provider = "OpenAI" if str(provider).lower() in {"codex", "openai", "openai-codex"} else provider
        entry = self._find_subscription_plan(normalized_provider, plan_type)
        price_source = str((entry or {}).get("source") or "official-list")
        if actual_price is not None:
            if isinstance(actual_price, bool) or not isinstance(actual_price, (int, float)) or actual_price < 0:
                return None
            price = float(actual_price)
            currency = actual_currency or (entry or {}).get("currency") or "USD"
            price_source = "user-entered"
        elif entry:
            price = float(entry.get("price"))
            currency = str(entry.get("currency") or "USD")
        else:
            return None

        catalog_period = str((entry or {}).get("billing_period") or "monthly")
        period_price = price
        if amortization_period == "weekly" and catalog_period == "monthly":
            period_price = price / 4.0
        elif amortization_period == "weekly" and catalog_period == "yearly":
            period_price = price / 52.0
        elif amortization_period != catalog_period:
            return None
        fraction = float(consumed_percentage) / 100.0
        return {
            "amount": round(period_price * fraction, 8),
            "currency": currency,
            "basis": "subscription-amortized",
            "plan_type": plan_type,
            "billing_period": amortization_period,
            "period_price": round(period_price, 8),
            "price_source": price_source,
            "fraction_of_period": fraction,
            "consumed_percentage": float(consumed_percentage),
            "confidence": "high" if price_source == "user-entered" else "medium",
            "availability": "available",
            "estimate_or_actual": "actual" if price_source == "user-entered" else "estimate",
        }

    def _find_subscription_plan(self, provider: str, plan_type: str) -> Optional[Dict[str, Any]]:
        plans = self.subscription_registry.get("plans", [])
        if not isinstance(plans, list):
            return None
        target = str(plan_type).strip().lower()
        for plan in plans:
            if not isinstance(plan, dict):
                continue
            if str(plan.get("provider", "")).lower() != str(provider).lower():
                continue
            names = [str(plan.get("plan_type", ""))] + [str(v) for v in plan.get("aliases", [])]
            if any(name.lower() == target for name in names):
                return plan
        return None

    def find_model_pricing(self, provider_or_model: Optional[str] = None, model_name: Optional[str] = None, **kwargs) -> Optional[Dict[str, Any]]:
        target_model = model_name or provider_or_model
        provider = provider_or_model if (model_name and provider_or_model != model_name) else kwargs.get("provider")

        if not target_model:
            return None

        models_list = self.pricing_registry.get("models", [])
        if isinstance(models_list, dict):
            return models_list.get(target_model)

        if not isinstance(models_list, list):
            return None

        # 1. Match by provider + model_name/alias
        if provider:
            for m in models_list:
                if not isinstance(m, dict):
                    continue
                if m.get("provider", "").lower() == provider.lower():
                    cid = m.get("canonical_model_id", "")
                    aliases = m.get("aliases", [])
                    if target_model == cid or target_model in aliases or target_model.lower() == cid.lower() or any(target_model.lower() == a.lower() for a in aliases):
                        return m

        # 2. Match by model_name/alias
        for m in models_list:
            if not isinstance(m, dict):
                continue
            cid = m.get("canonical_model_id", "")
            aliases = m.get("aliases", [])
            if target_model == cid or target_model in aliases or target_model.lower() == cid.lower() or any(target_model.lower() == a.lower() for a in aliases):
                return m

        return None

    def calculate_cost(
        self,
        model_name: Optional[str] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        provider: Optional[str] = None,
    ) -> PricingInfo:
        if not model_name:
            return PricingInfo(status="PRICE_NOT_AVAILABLE")

        model_cfg = self.find_model_pricing(provider, model_name)
        if not model_cfg:
            return PricingInfo(status="PRICE_NOT_AVAILABLE")

        # Verification check
        ver_status = model_cfg.get("verification_status") or model_cfg.get("status")
        is_verified = (ver_status == "VERIFIED") or model_cfg.get("verified", False)
        if not is_verified:
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
                price_snapshot_version=self.pricing_registry.get("version"),
                price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="UNVERIFIED",
            )

        if input_tokens is None or output_tokens is None:
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
                price_snapshot_version=self.pricing_registry.get("version"),
                price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="USAGE_NOT_AVAILABLE",
            )

        # Invalid usage checks (non-integer or negative)
        for tok_val, tok_name in [
            (input_tokens, "input_tokens"),
            (output_tokens, "output_tokens"),
            (reasoning_tokens, "reasoning_tokens"),
            (cache_read_tokens, "cache_read_tokens"),
            (cache_write_tokens, "cache_write_tokens"),
        ]:
            if tok_val is not None:
                if not isinstance(tok_val, int) or isinstance(tok_val, bool) or tok_val < 0:
                    return PricingInfo(status="INVALID_USAGE")

        # Reasoning tokens contract check
        if reasoning_tokens and reasoning_tokens > 0:
            if not model_cfg.get("reasoning_included_in_output", False):
                return PricingInfo(status="PRICE_NOT_AVAILABLE")

        input_rate = model_cfg.get("input_price_per_1m")
        output_rate = model_cfg.get("output_price_per_1m")
        cache_read_rate = model_cfg.get("cached_input_price_per_1m")
        cache_write_rate = model_cfg.get("cache_write_price_per_1m")

        if input_rate is None or output_rate is None:
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
                price_snapshot_version=self.pricing_registry.get("version"),
                price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="PRICE_NOT_AVAILABLE",
            )
        cache_read_rate = cache_read_rate if cache_read_rate is not None else input_rate
        cache_write_rate = cache_write_rate if cache_write_rate is not None else input_rate

        c_read = cache_read_tokens or 0
        c_write = cache_write_tokens or 0
        usage_semantics = model_cfg.get("usage_semantics") or {}
        if usage_semantics.get("input_includes_cache_buckets", True):
            uncached_input = input_tokens - c_read - c_write
            if uncached_input < 0:
                return PricingInfo(status="INVALID_USAGE")
        else:
            uncached_input = input_tokens

        # Token cost calculation
        cost = (
            (uncached_input * (input_rate / 1_000_000.0))
            + (c_read * (cache_read_rate / 1_000_000.0))
            + (c_write * (cache_write_rate / 1_000_000.0))
            + (output_tokens * (output_rate / 1_000_000.0))
        )

        return PricingInfo(
            price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
            price_snapshot_version=self.pricing_registry.get("version"),
            price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
            currency="USD",
            api_equivalent_cost_usd=round(cost, 6),
            actual_billed_cost_usd=None,
            status="CALCULATED",
        )
