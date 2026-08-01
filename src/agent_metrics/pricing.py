"""
Pricing engine for calculating API equivalent cost based on model-pricing.json.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional
from .models import PricingInfo


class PricingEngine:
    def __init__(self, config_path: Optional[Path] = None):
        if config_path is None:
            project_root = Path(__file__).resolve().parent.parent.parent
            config_path = project_root / "config" / "model-pricing.json"

        self.config_path = config_path
        self.pricing_registry: Dict[str, Any] = {}
        self.load_pricing()

    def load_pricing(self) -> None:
        if self.config_path.is_file():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    self.pricing_registry = json.load(f)
            except Exception:
                self.pricing_registry = {"models": []}
        else:
            self.pricing_registry = {"models": []}

    def find_model_pricing(self, provider: str, model_name: str) -> Optional[Dict[str, Any]]:
        if not model_name:
            return None

        norm_provider = provider.lower() if provider else ""
        norm_model = model_name.lower().strip()

        models = self.pricing_registry.get("models", [])
        for entry in models:
            entry_provider = entry.get("provider", "").lower()
            canonical = entry.get("canonical_model_id", "").lower()
            aliases = [a.lower() for a in entry.get("aliases", [])]

            if (norm_provider and norm_provider in entry_provider) or not norm_provider:
                if norm_model == canonical or norm_model in aliases:
                    return entry
        return None

    def calculate_cost(
        self,
        provider: str,
        model_name: str,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
    ) -> PricingInfo:
        pricing_entry = self.find_model_pricing(provider, model_name)

        if not pricing_entry:
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date"),
                price_source=None,
                currency="USD",
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="PRICE_NOT_AVAILABLE",
            )

        status_in_registry = pricing_entry.get("verification_status", "UNVERIFIED")
        if status_in_registry != "VERIFIED":
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date"),
                price_source=pricing_entry.get("source_url"),
                currency=pricing_entry.get("currency", "USD"),
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="UNVERIFIED",
            )

        # Check if tokens are provided
        if input_tokens is None and output_tokens is None:
            return PricingInfo(
                price_snapshot_date=self.pricing_registry.get("pricing_date"),
                price_source=pricing_entry.get("source_url"),
                currency=pricing_entry.get("currency", "USD"),
                api_equivalent_cost_usd=None,
                actual_billed_cost_usd=None,
                status="CALCULATED",
            )

        input_price = pricing_entry.get("input_price_per_1m") or 0.0
        cached_input_price = pricing_entry.get("cached_input_price_per_1m") or input_price
        cache_write_price = pricing_entry.get("cache_write_price_per_1m") or input_price
        output_price = pricing_entry.get("output_price_per_1m") or 0.0
        reasoning_price = pricing_entry.get("reasoning_price_per_1m") or output_price

        # Net standard input tokens = input_tokens - (cache_read_tokens + cache_write_tokens)
        c_read = cache_read_tokens or 0
        c_write = cache_write_tokens or 0
        tot_input = input_tokens or 0
        reg_input = max(0, tot_input - (c_read + c_write))

        cost_reg_input = (reg_input / 1_000_000.0) * input_price
        cost_cache_read = (c_read / 1_000_000.0) * cached_input_price
        cost_cache_write = (c_write / 1_000_000.0) * cache_write_price

        out_tok = output_tokens or 0
        reas_tok = reasoning_tokens or 0
        reg_out = max(0, out_tok - reas_tok)

        cost_output = (reg_out / 1_000_000.0) * output_price
        cost_reasoning = (reas_tok / 1_000_000.0) * reasoning_price

        total_cost = cost_reg_input + cost_cache_read + cost_cache_write + cost_output + cost_reasoning
        rounded_cost = round(total_cost, 6)

        return PricingInfo(
            price_snapshot_date=self.pricing_registry.get("pricing_date"),
            price_source=pricing_entry.get("source_url"),
            currency=pricing_entry.get("currency", "USD"),
            api_equivalent_cost_usd=rounded_cost,
            actual_billed_cost_usd=None,
            status="CALCULATED",
        )
