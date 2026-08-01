"""
Security boundaries and secret redaction tests (Phase 4.4 & 4.5).
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.storage import StorageManager
from agent_metrics.redaction import redact_data, scan_text_for_secret_types


class TestSecurityBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # Path traversal protection
    def test_path_traversal_prevention(self):
        invalid_ids = [
            "../outside",
            "..\\outside",
            "run/../../etc",
            "run;rm -rf /",
            "CON",
        ]
        for bad_id in invalid_ids:
            with self.assertRaises(ValueError):
                self.storage.get_run_dir(bad_id)

    # Secret Redaction testing
    def test_secret_redaction_thorough(self):
        sensitive_payload = {
            "bearer": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
            "api_key": "sk-1234567890abcdef1234567890",
            "gocspx": "GOCSPX-1234567890abcdef",
            "email": "user@domain.com",
            "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456",
            "url": "http://localhost:8080/api?token=secrettoken12345",
            "auth_header": "Authorization: Bearer secret",
            "cookie_header": "Cookie: session_id=secret_cookie_val",
        }

        sanitized, warnings = redact_data(sensitive_payload)

        json_str = json.dumps(sanitized)
        self.assertNotIn("sk-1234567890abcdef1234567890", json_str)
        self.assertNotIn("GOCSPX-1234567890abcdef", json_str)
        self.assertNotIn("user@domain.com", json_str)
        self.assertNotIn("secrettoken12345", json_str)
        self.assertIn("secret_like_value_redacted", warnings)

    # Secret scanner verification
    def test_scan_text_for_secret_types(self):
        text1 = "sk-12345678901234567890123456"
        found = scan_text_for_secret_types(text1)
        self.assertIn("sk- API Key", found)

        text2 = "Normal log without secrets"
        found2 = scan_text_for_secret_types(text2)
        self.assertEqual(len(found2), 0)


if __name__ == "__main__":
    unittest.main()
