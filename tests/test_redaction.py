"""
Unit tests for Redaction Engine and Integrity hashing.
Reads fake secrets strictly from fixture file.
"""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_metrics.redaction import redact_text, redact_home_path, sanitize_dict, scan_text_for_secret_types
from agent_metrics.integrity import compute_payload_sha256, compute_file_sha256, verify_summary_integrity
from agent_metrics.storage import StorageManager
from agent_metrics.cli import CLIHandler

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json"


class TestRedactionAndIntegrity(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            self.fake_secrets = json.load(f)
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

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

    def test_home_path_redaction_backslash_and_slash(self):
        fake_home = r"C:\Users\PrivateDeveloper"
        with patch("pathlib.Path.home", return_value=Path(fake_home)):
            with patch.dict(os.environ, {"USERPROFILE": fake_home, "USERNAME": "PrivateDeveloper"}):
                txt_bs = r"Path is c:\users\privatedeveloper\projects\myrepo"
                res_bs = redact_home_path(txt_bs)
                self.assertIn("[HOME]", res_bs)
                self.assertNotIn("PrivateDeveloper", res_bs)

                txt_fs = "Path is C:/Users/PrivateDeveloper/projects/myrepo"
                res_fs = redact_home_path(txt_fs)
                self.assertIn("[HOME]", res_fs)
                self.assertNotIn("PrivateDeveloper", res_fs)

    def test_run_context_privacy(self):
        fake_home = r"C:\Users\PrivateUser"
        fake_worktree = r"C:\Users\PrivateUser\projects\smoke-target"
        storage = StorageManager(base_dir=self.temp_dir)

        with patch("pathlib.Path.home", return_value=Path(fake_home)):
            with patch.dict(os.environ, {"USERPROFILE": fake_home, "USERNAME": "PrivateUser"}):
                run_id = storage.create_run({
                    "started_at": "2026-08-01T10:00:00Z",
                    "work_package": "WP-PRIVACY-TEST",
                    "worktree": fake_worktree,
                    "agent": {"shell": "Claude-Code", "provider": "Anthropic"}
                })
                ctx = storage.read_run_context(run_id)

                self.assertEqual(ctx["run_id"], run_id)
                self.assertEqual(ctx["work_package"], "WP-PRIVACY-TEST")
                self.assertTrue(ctx["worktree"].startswith("[HOME]"))
                self.assertNotIn("PrivateUser", json.dumps(ctx))
                self.assertNotIn("prompt", ctx)
                self.assertNotIn("messages", ctx)
                self.assertNotIn("content", ctx)

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
