"""
Pricing Engine for calculating API Equivalent Cost (USD).
Calculates equivalent provider list price.
Note:
- Input tokens, cache read tokens, cache write tokens, and output tokens are independent buckets.
- Reasoning tokens must be declared by Pricing Registry (reasoning_included_in_output).
- Unverified models return UNVERIFIED and null cost.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional, List, Union

from agent_metrics.models import PricingInfo


class PricingEngine:
    def __init__(self, pricing_file: Optional[Path] = None):
        if not pricing_file:
            pricing_file = Path(__file__).resolve().parent.parent.parent / "config" / "model-pricing.json"
        self.pricing_file = Path(pricing_file)
        self.pricing_registry = self._load_registry()

    def _load_registry(self) -> Dict[str, Any]:
        if not self.pricing_file.exists():
            return {}
        try:
            with open(self.pricing_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

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
                price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="UNVERIFIED",
            )

        if input_tokens is None:
            input_tokens = 0
        if output_tokens is None:
            output_tokens = 0

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

        input_rate = model_cfg.get("input_price_per_1m") or model_cfg.get("rates", {}).get("input_per_million", 0.0) or 0.0
        output_rate = model_cfg.get("output_price_per_1m") or model_cfg.get("rates", {}).get("output_per_million", 0.0) or 0.0
        cache_read_rate = model_cfg.get("cached_input_price_per_1m") or model_cfg.get("rates", {}).get("cache_read_per_million", 0.0) or 0.0
        cache_write_rate = model_cfg.get("cache_write_price_per_1m") or model_cfg.get("rates", {}).get("cache_write_per_million", 0.0) or 0.0

        c_read = cache_read_tokens or 0
        c_write = cache_write_tokens or 0
        uncached_input = max(0, input_tokens - c_read - c_write)

        # Token cost calculation
        cost = (
            (uncached_input * (input_rate / 1_000_000.0))
            + (c_read * (cache_read_rate / 1_000_000.0))
            + (c_write * (cache_write_rate / 1_000_000.0))
            + (output_tokens * (output_rate / 1_000_000.0))
        )

        return PricingInfo(
            price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
            price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
            currency="USD",
            api_equivalent_cost_usd=round(cost, 6),
            actual_billed_cost_usd=None,
            status="CALCULATED",
        )
