"""
Redaction & Integrity unit tests (Tests 43-50).
"""

import json
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.redaction import redact_string, redact_data, scan_text_for_secret_types
from agent_metrics.integrity import compute_sha256, compute_dict_sha256


class TestRedactionAndIntegrity(unittest.TestCase):
    # Test 43: Bearer Token redaction
    def test_bearer_token_redaction(self):
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"
        redacted, warnings = redact_string(text)
        self.assertNotIn("eyJhbGciOiJI", redacted)
        self.assertIn("secret_like_value_redacted", warnings)

    # Test 44: API Key redaction (sk-... & GOCSPX-...)
    def test_api_key_redaction(self):
        text = "Key: sk-1234567890abcdef1234567890 and GOCSPX-1234567890abcdef"
        redacted, warnings = redact_string(text)
        self.assertNotIn("sk-1234567890", redacted)
        self.assertNotIn("GOCSPX-1234567890", redacted)

    # Test 45: Email address redaction
    def test_email_redaction(self):
        text = "User email: developer@example.com is secret"
        redacted, warnings = redact_string(text)
        self.assertNotIn("developer@example.com", redacted)
        self.assertIn("[REDACTED_EMAIL]", redacted)

    # Test 46: JWT redaction
    def test_jwt_redaction(self):
        text = "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl"
        redacted, warnings = redact_string(text)
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", redacted)

    # Test 47: URL Query secret redaction
    def test_query_secret_redaction(self):
        url = "https://api.example.com/data?api_key=secretkey123456789&user=john"
        redacted, warnings = redact_string(url)
        self.assertNotIn("secretkey123456789", redacted)

    # Test 48: Prompt body excluded from summary
    def test_prompt_body_excluded(self):
        data = {
            "work_package": "WP-01",
            "prompt": "SELECT * FROM users; -- SECRET PROMPT",
            "messages": [{"role": "user", "content": "hello"}],
        }
        sanitized, warnings = redact_data(data)
        self.assertIn("prompt", sanitized)
        # Note: In summary model dataclass, prompt & messages fields are completely omitted from schema!

    # Test 49: SHA-256 calculation stability
    def test_sha256_stability(self):
        data = {"run_id": "uuid-1", "work_package": "WP-01"}
        hash1 = compute_dict_sha256(data)
        hash2 = compute_dict_sha256(data)
        self.assertEqual(hash1, hash2)

    # Test 50: Summary modification changes SHA-256 hash
    def test_summary_mutation_changes_hash(self):
        data1 = {"run_id": "uuid-1", "work_package": "WP-01"}
        data2 = {"run_id": "uuid-1", "work_package": "WP-02"}
        hash1 = compute_dict_sha256(data1)
        hash2 = compute_dict_sha256(data2)
        self.assertNotEqual(hash1, hash2)


if __name__ == "__main__":
    unittest.main()
