"""
Unit tests for security boundaries and path traversal prevention.
Reads fake secrets strictly from fixture file.
"""

import json
import unittest
from pathlib import Path

from agent_metrics.storage import StorageManager
from agent_metrics.redaction import scan_text_for_secret_types

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json"


class TestSecurityBoundaries(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            self.fake_secrets = json.load(f)

    def test_path_traversal_prevention(self):
        invalid_ids = ["../etc/passwd", "..\\Windows\\System32", "COM1", "CON", "NUL", "run/../../sub"]
        for bad_id in invalid_ids:
            with self.subTest(run_id=bad_id):
                with self.assertRaises(ValueError):
                    StorageManager.validate_run_id(bad_id)

    def test_scan_text_for_secret_types(self):
        sample = f"{self.fake_secrets['fake_bearer']} {self.fake_secrets['fake_sk_api_key']} {self.fake_secrets['fake_email']}"
        types = scan_text_for_secret_types(sample)
        self.assertIn("Bearer Token", types)
        self.assertIn("sk- API Key", types)
        self.assertIn("Email Address", types)

    def test_secret_redaction_thorough(self):
        types = scan_text_for_secret_types(self.fake_secrets['fake_query'])
        self.assertIn("URL Query Secret", types)


if __name__ == "__main__":
    unittest.main()
