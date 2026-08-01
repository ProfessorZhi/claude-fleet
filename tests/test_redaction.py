"""
Unit tests for Redaction Engine and Integrity hashing.
Reads fake secrets strictly from fixture file.
"""

import json
import unittest
from pathlib import Path

from agent_metrics.redaction import redact_text, sanitize_dict, scan_text_for_secret_types
from agent_metrics.integrity import compute_payload_sha256, compute_file_sha256, verify_summary_integrity

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json"


class TestRedactionAndIntegrity(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            self.fake_secrets = json.load(f)

    def test_bearer_token_redaction(self):
        txt = f"Header: {self.fake_secrets['fake_bearer']}"
        res = redact_text(txt)
        self.assertNotIn("eyJhbGci", res)
        self.assertIn("Bearer [REDACTED]", res)

    def test_api_key_redaction(self):
        txt = f"Key is {self.fake_secrets['fake_sk_api_key']}"
        res = redact_text(txt)
        self.assertNotIn("sk-1234567890", res)
        self.assertIn("[REDACTED_API_KEY]", res)

    def test_jwt_redaction(self):
        txt = f"JWT: {self.fake_secrets['fake_jwt']}"
        res = redact_text(txt)
        self.assertNotIn("eyJhbGci", res)
        self.assertIn("[REDACTED_JWT]", res)

    def test_email_redaction(self):
        txt = f"Contact {self.fake_secrets['fake_email']}"
        res = redact_text(txt)
        self.assertNotIn(self.fake_secrets["fake_email"], res)
        self.assertIn("[REDACTED_EMAIL]", res)

    def test_query_secret_redaction(self):
        txt = self.fake_secrets['fake_query']
        res = redact_text(txt)
        self.assertNotIn("secret12345", res)
        self.assertIn("[REDACTED]", res)

    def test_prompt_body_excluded(self):
        data = {
            "input_tokens": 150,
            "output_tokens": 80,
            "prompt": "Secret prompt text",
            "messages": [{"role": "user", "content": "hello"}],
            "commit_sha": "adbe2efdbaa6fc56ac7f732158c18b1818cd3ce2",
        }
        sanitized = sanitize_dict(data)
        self.assertNotIn("prompt", sanitized)
        self.assertNotIn("messages", sanitized)
        self.assertEqual(sanitized["input_tokens"], 150)
        self.assertEqual(sanitized["output_tokens"], 80)
        self.assertEqual(sanitized["commit_sha"], "adbe2efdbaa6fc56ac7f732158c18b1818cd3ce2")

    def test_sha256_stability(self):
        payload = {"run_id": "test-uuid", "work_package": "WP-01", "integrity": {}}
        h1 = compute_payload_sha256(payload)
        h2 = compute_payload_sha256(payload)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)

    def test_summary_mutation_changes_hash(self):
        payload = {"run_id": "test-uuid", "work_package": "WP-01", "integrity": {}}
        h1 = compute_payload_sha256(payload)
        payload["work_package"] = "WP-02"
        h2 = compute_payload_sha256(payload)
        self.assertNotEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
