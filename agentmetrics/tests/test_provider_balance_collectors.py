import io
import json
import os
import unittest
from unittest.mock import patch

from agent_metrics.collectors.provider_balance_collectors import (
    DeepSeekBalanceCollector,
    MiniMaxTokenPlanCollector,
)


class _Resp:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class TestProviderBalanceCollectors(unittest.TestCase):
    def test_deepseek_missing_key_config_required(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(DeepSeekBalanceCollector().collect()["status"], "CONFIG_REQUIRED")

    def test_deepseek_balance_mapping(self):
        payload = {
            "balance_infos": [{
                "is_available": True,
                "currency": "USD",
                "total_balance": "10",
                "granted_balance": "1",
                "topped_up_balance": "9",
                "email": "drop-redacted",
            }]
        }
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "explicit-test-key"}, clear=True):
            with patch("agent_metrics.collectors.provider_balance_collectors.urllib.request.OpenerDirector.open", return_value=_Resp(payload)):
                res = DeepSeekBalanceCollector().collect()
        self.assertEqual(res["status"], "AVAILABLE")
        self.assertEqual(res["balance"]["currency"], "USD")
        self.assertNotIn("drop-redacted", json.dumps(res))

    def test_minimax_missing_key_config_required(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(MiniMaxTokenPlanCollector().collect()["status"], "CONFIG_REQUIRED")

    def test_minimax_payload_sanitized(self):
        payload = {"plans": [{"remaining": 5, "reset_at": "2026-08-01T00:00:00Z"}], "api_key": "drop"}
        with patch.dict(os.environ, {"MINIMAX_TOKEN_PLAN_KEY": "explicit-test-key"}, clear=True):
            with patch("agent_metrics.collectors.provider_balance_collectors.urllib.request.OpenerDirector.open", return_value=_Resp(payload)):
                res = MiniMaxTokenPlanCollector().collect()
        self.assertEqual(res["status"], "AVAILABLE")
        self.assertNotIn("api_key", json.dumps(res))


if __name__ == "__main__":
    unittest.main()
