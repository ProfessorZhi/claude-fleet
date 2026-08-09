"""
Unit tests for standard library Schema Contract Validator.
"""

import unittest
from agent_metrics.validators import (
    validate_run_context,
    validate_sanitized_summary,
    validate_usage,
    validate_pricing,
)


class TestValidators(unittest.TestCase):
    def test_valid_usage(self):
        data = {
            "input_tokens": 100,
            "output_tokens": 50,
            "reasoning_tokens": 10,
            "collection_status": "COMPLETE",
        }
        # Should not raise exception
        validate_usage(data)

    def test_invalid_negative_tokens(self):
        data = {"input_tokens": -5, "collection_status": "COMPLETE"}
        with self.assertRaises(ValueError):
            validate_usage(data)

    def test_invalid_reasoning_exceeds_output(self):
        data = {"output_tokens": 10, "reasoning_tokens": 20, "collection_status": "COMPLETE"}
        with self.assertRaises(ValueError):
            validate_usage(data)

    def test_invalid_pricing_cost(self):
        data = {"status": "CALCULATED", "api_equivalent_cost_usd": -0.5}
        with self.assertRaises(ValueError):
            validate_pricing(data)

    def test_valid_sanitized_summary(self):
        summary = {
            "schema_version": 1,
            "collector_version": "0.1.0",
            "run_id": "12345678-1234-1234-1234-123456789012",
            "work_package": "WP-TEST",
            "agent": {"shell": "bash", "provider": "Anthropic"},
            "timing": {"started_at": "2026-08-01T10:00:00Z"},
            "usage": {"collection_status": "NOT_AVAILABLE"},
            "pricing": {"status": "PRICE_NOT_AVAILABLE"},
            "quota": {},
            "git": {},
            "github": {},
            "collectors": {},
            "warnings": [],
            "integrity": {"payload_sha256": "a" * 64},
        }
        validate_sanitized_summary(summary)


if __name__ == "__main__":
    unittest.main()
