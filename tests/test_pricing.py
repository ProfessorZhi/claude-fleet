"""
Pricing Engine unit tests (Tests 35-42).
"""

import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.pricing import PricingEngine


class TestPricingEngine(unittest.TestCase):
    def setUp(self):
        self.pricing = PricingEngine()

    # Test 35: Verified model pricing calculation
    def test_verified_model_pricing(self):
        res = self.pricing.calculate_cost(
            provider="Anthropic",
            model_name="claude-3-5-sonnet-20241022",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
        )
        self.assertEqual(res.status, "CALCULATED")
        # 1M input @ $3.00 + 1M output @ $15.00 = $18.00
        self.assertEqual(res.api_equivalent_cost_usd, 18.00)

    # Test 36: Unknown model calculation
    def test_unknown_model_pricing(self):
        res = self.pricing.calculate_cost(
            provider="UnknownProvider",
            model_name="unknown-model-xyz",
            input_tokens=100_000,
        )
        self.assertEqual(res.status, "PRICE_NOT_AVAILABLE")
        self.assertIsNone(res.api_equivalent_cost_usd)

    # Test 37: Unverified price status
    def test_unverified_model_pricing(self):
        res = self.pricing.calculate_cost(
            provider="DeepSeek",
            model_name="deepseek-v4-flash",
            input_tokens=100_000,
        )
        self.assertEqual(res.status, "UNVERIFIED")
        self.assertIsNone(res.api_equivalent_cost_usd)

    # Test 38: Cache read cost calculation
    def test_cache_read_cost(self):
        res = self.pricing.calculate_cost(
            provider="Anthropic",
            model_name="claude-3-5-sonnet-20241022",
            input_tokens=1_000_000,
            cache_read_tokens=1_000_000,  # 1M cached input @ $0.30
            output_tokens=0,
        )
        self.assertEqual(res.status, "CALCULATED")
        self.assertEqual(res.api_equivalent_cost_usd, 0.30)

    # Test 39: Cache write cost calculation
    def test_cache_write_cost(self):
        res = self.pricing.calculate_cost(
            provider="Anthropic",
            model_name="claude-3-5-sonnet-20241022",
            input_tokens=1_000_000,
            cache_write_tokens=1_000_000,  # 1M cache write @ $3.75
            output_tokens=0,
        )
        self.assertEqual(res.status, "CALCULATED")
        self.assertEqual(res.api_equivalent_cost_usd, 3.75)

    # Test 40: Output cost calculation
    def test_output_cost(self):
        res = self.pricing.calculate_cost(
            provider="DeepSeek",
            model_name="deepseek-chat",
            input_tokens=0,
            output_tokens=1_000_000,  # 1M output @ $1.10
        )
        self.assertEqual(res.status, "CALCULATED")
        self.assertEqual(res.api_equivalent_cost_usd, 1.10)

    # Test 41: Context tier matching
    def test_context_tier_matching(self):
        entry = self.pricing.find_model_pricing("Anthropic", "claude-3.5-sonnet")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["context_window_tier"], "200k")

    # Test 42: Missing tokens calculation (returns status without cost)
    def test_missing_tokens_cost(self):
        res = self.pricing.calculate_cost(
            provider="Anthropic",
            model_name="claude-3-5-sonnet-20241022",
            input_tokens=None,
            output_tokens=None,
        )
        self.assertEqual(res.status, "CALCULATED")
        self.assertIsNone(res.api_equivalent_cost_usd)


if __name__ == "__main__":
    unittest.main()
