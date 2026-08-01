"""
Pricing Engine for calculating API Equivalent Cost (USD).
Calculates equivalent provider list price.
Note:
- Reasoning tokens are considered a subset of output_tokens.
- Cache read/write tokens are subsets of input_tokens.
- Context tier selection is evaluated against total input_tokens.
- Unverified models return UNVERIFIED and null cost.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional, List

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

    def find_model_pricing(self, provider: Optional[str], model_name: str) -> Optional[Dict[str, Any]]:
        models_list = self.pricing_registry.get("models", [])
        if isinstance(models_list, dict):
            return models_list.get(model_name)

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
                    if model_name == cid or model_name in aliases or model_name.lower() == cid.lower() or any(model_name.lower() == a.lower() for a in aliases):
                        return m

        # 2. Match by model_name/alias
        for m in models_list:
            if not isinstance(m, dict):
                continue
            cid = m.get("canonical_model_id", "")
            aliases = m.get("aliases", [])
            if model_name == cid or model_name in aliases or model_name.lower() == cid.lower() or any(model_name.lower() == a.lower() for a in aliases):
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
        if not model_name or input_tokens is None or output_tokens is None:
            return PricingInfo(status="PRICE_NOT_AVAILABLE")

        # 1. Invalid Usage Validation
        if input_tokens < 0 or output_tokens < 0:
            return PricingInfo(status="INVALID_USAGE")
        if reasoning_tokens is not None and (reasoning_tokens < 0 or reasoning_tokens > output_tokens):
            return PricingInfo(status="INVALID_USAGE")
        if cache_read_tokens is not None and (cache_read_tokens < 0 or cache_read_tokens > input_tokens):
            return PricingInfo(status="INVALID_USAGE")
        if cache_write_tokens is not None and (cache_write_tokens < 0 or cache_write_tokens > input_tokens):
            return PricingInfo(status="INVALID_USAGE")

        model_cfg = self.find_model_pricing(provider, model_name)
        if not model_cfg:
            return PricingInfo(status="PRICE_NOT_AVAILABLE")

        ver_status = model_cfg.get("verification_status") or model_cfg.get("status")
        if ver_status != "VERIFIED" and not model_cfg.get("verified", False):
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date") or self.pricing_registry.get("snapshot_date"),
                price_source=model_cfg.get("source_url") or self.pricing_registry.get("source"),
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="UNVERIFIED",
            )

        input_rate = model_cfg.get("input_price_per_1m") or model_cfg.get("rates", {}).get("input_per_million", 0.0) or 0.0
        output_rate = model_cfg.get("output_price_per_1m") or model_cfg.get("rates", {}).get("output_per_million", 0.0) or 0.0
        cache_read_rate = model_cfg.get("cached_input_price_per_1m") or model_cfg.get("rates", {}).get("cache_read_per_million", input_rate) or input_rate
        cache_write_rate = model_cfg.get("cache_write_price_per_1m") or model_cfg.get("rates", {}).get("cache_write_per_million", input_rate) or input_rate

        c_read = cache_read_tokens or 0
        c_write = cache_write_tokens or 0
        uncached_input = max(0, input_tokens - c_read - c_write)

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
