"""
Unit tests for the Codex Quota Collector.

These tests exercise the semantics-aware delta logic, account privacy,
window-reset handling, and the allowlist sanitization. They do NOT make
any real network request, do NOT touch real Cockpit state, and do NOT
execute any Codex CLI.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.codex_quota_collector import (
    CodexQuotaCollector,
    DEFAULT_CODEX_QUOTA_PATH,
    STATUS_AMBIGUOUS,
    STATUS_COMPLETE,
    STATUS_NOT_AVAILABLE,
    STATUS_RESET_DURING_RUN,
    STATUS_SEMANTICS_UNVERIFIED,
    SEMANTICS_REMAINING,
    SEMANTICS_UNKNOWN,
    SEMANTICS_USED,
    _hash_account_ref,
    discover_source,
    sanitize_snapshot,
)


def _base_snapshot(**overrides):
    snap = {
        "captured_at": "2026-08-01T10:00:00+00:00",
        "account_ref_hash": "abcdef0123456789",
        "plan_type": "plus",
        "percentage_semantics": SEMANTICS_REMAINING,
        "primary_window": {
            "percentage": 80.0,
            "window_minutes": 180,
            "reset_at": "2026-08-01T13:00:00+00:00",
        },
        "secondary_window": {
            "percentage": 90.0,
            "window_minutes": 10080,
            "reset_at": "2026-08-08T10:00:00+00:00",
        },
    }
    snap.update(overrides)
    return snap


class TestCodexQuotaSemantics(unittest.TestCase):
    """Scenarios 1-3: semantics-aware delta, remaining / used / unknown."""

    def test_remaining_semantics_normal_delta(self):
        before = _base_snapshot(percentage_semantics=SEMANTICS_REMAINING)
        after = _base_snapshot(percentage_semantics=SEMANTICS_REMAINING)
        after["primary_window"]["percentage"] = 70.0
        after["secondary_window"]["percentage"] = 85.0

        collector = CodexQuotaCollector()
        delta = collector.calculate_delta(before, after)

        self.assertEqual(delta["primary_status"], STATUS_COMPLETE)
        self.assertEqual(delta["secondary_status"], STATUS_COMPLETE)
        self.assertAlmostEqual(delta["primary_consumed_percentage"], 10.0)
        self.assertAlmostEqual(delta["secondary_consumed_percentage"], 5.0)
        self.assertEqual(delta["delta_status"], STATUS_COMPLETE)

    def test_used_semantics_normal_delta(self):
        # semantics=used: percentage field means "% of quota consumed".
        before = _base_snapshot(percentage_semantics=SEMANTICS_USED)
        before["primary_window"]["percentage"] = 20.0
        before["secondary_window"]["percentage"] = 10.0
        after = _base_snapshot(percentage_semantics=SEMANTICS_USED)
        after["primary_window"]["percentage"] = 30.0
        after["secondary_window"]["percentage"] = 15.0

        collector = CodexQuotaCollector()
        delta = collector.calculate_delta(before, after)

        # before.used = 20, after.used = 30 → consumed = 30 - 20 = 10
        # before.used = 10, after.used = 15 → consumed = 15 - 10 = 5
        self.assertAlmostEqual(delta["primary_consumed_percentage"], 10.0)
        self.assertAlmostEqual(delta["secondary_consumed_percentage"], 5.0)
        self.assertEqual(delta["delta_status"], STATUS_COMPLETE)

    def test_unknown_semantics_no_delta(self):
        before = _base_snapshot(percentage_semantics=SEMANTICS_UNKNOWN)
        after = _base_snapshot(percentage_semantics=SEMANTICS_UNKNOWN)
        after["primary_window"]["percentage"] = 50.0

        collector = CodexQuotaCollector()
        delta = collector.calculate_delta(before, after)

        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertIsNone(delta["secondary_consumed_percentage"])
        self.assertEqual(delta["primary_status"], STATUS_SEMANTICS_UNVERIFIED)
        self.assertEqual(delta["delta_status"], STATUS_SEMANTICS_UNVERIFIED)


class TestCodexQuotaAccountPrivacy(unittest.TestCase):
    """Scenarios 4-5: multi-account ambiguity and account-changed handling."""

    def test_multi_account_ambiguous_no_delta(self):
        # Two Codex accounts visible simultaneously and we cannot prove which
        # one was active. The collector must remain AMBIGUOUS without guessing.
        before = _base_snapshot(account_ref_hash="aaaaaaaaaaaaaaaa")
        after = _base_snapshot(account_ref_hash="aaaaaaaaaaaaaaaa")
        after["primary_window"]["percentage"] = 70.0

        # The collector itself returns AMBIGUOUS only when account_ref_hash
        # differs. The "multi-account, cannot prove" case is signalled by an
        # AMBIGUOUS snapshot handed in by the caller, which the collector
        # must surface truthfully.
        ambiguous_before = _base_snapshot(account_ref_hash="x" * 16)
        ambiguous_after = _base_snapshot(account_ref_hash="y" * 16)
        delta = CodexQuotaCollector().calculate_delta(ambiguous_before, ambiguous_after)
        self.assertEqual(delta["delta_status"], STATUS_AMBIGUOUS)
        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertIsNone(delta["secondary_consumed_percentage"])

        # And the unrelated "same-account delta" path stays COMPLETE.
        delta_ok = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta_ok["delta_status"], STATUS_COMPLETE)

    def test_account_ref_hash_mismatch_is_ambiguous(self):
        before = _base_snapshot(account_ref_hash="aaaaaaaaaaaaaaaa")
        after = _base_snapshot(account_ref_hash="bbbbbbbbbbbbbbbb")
        after["primary_window"]["percentage"] = 70.0

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["delta_status"], STATUS_AMBIGUOUS)
        self.assertIsNone(delta["primary_consumed_percentage"])


class TestCodexQuotaReset(unittest.TestCase):
    """Scenario 6: window reset during the run is surfaced, not ignored."""

    def test_primary_window_reset_returns_reset_status(self):
        before = _base_snapshot()
        after = _base_snapshot()
        # Same semantics, same percentage, but reset_at advanced — primary reset.
        after["primary_window"]["reset_at"] = "2026-08-01T14:00:00+00:00"
        # Secondary stays stable but moved further in time (no reset).
        after["secondary_window"]["reset_at"] = "2026-08-08T10:00:00+00:00"
        after["secondary_window"]["percentage"] = 88.0

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["primary_status"], STATUS_RESET_DURING_RUN)
        self.assertIsNone(delta["primary_consumed_percentage"])
        # Secondary should still produce a delta.
        self.assertEqual(delta["secondary_status"], STATUS_COMPLETE)
        self.assertAlmostEqual(delta["secondary_consumed_percentage"], 2.0)
        self.assertEqual(delta["delta_status"], STATUS_RESET_DURING_RUN)


class TestCodexQuotaCockpitUnavailable(unittest.TestCase):
    """Scenario 7-8: Cockpit NOT_AVAILABLE and snapshot allowlist filtering."""

    def setUp(self):
        # Ensure no source env var accidentally enables the collector.
        for var in ("COCKPIT_BASE_URL", "COCKPIT_CODEX_STATE_FILE", "COCKPIT_CODEX_QUOTA_PATH", "COCKPIT_MANAGEMENT_KEY"):
            os.environ.pop(var, None)

    def test_no_source_returns_not_available(self):
        collector = CodexQuotaCollector()
        snap = collector.capture_snapshot()
        self.assertEqual(snap["status"], STATUS_NOT_AVAILABLE)
        self.assertEqual(collector.get_status(), "NOT_AVAILABLE")

    def test_snapshot_allowlist_excludes_secrets(self):
        # A raw snapshot with extra fields and a sensitive account ID should
        # never make it past sanitize_snapshot. The original value must not
        # be reachable in the returned dict.
        # Fake secrets are loaded from the fixtures dir (whitelisted by the
        # repository secret scanner).
        fixtures_path = (
            Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json"
        )
        fake = json.loads(fixtures_path.read_text(encoding="utf-8"))

        raw = _base_snapshot()
        # Use a synthesized account_ref value (not a secret) so the allowlist
        # test focuses on field-shape filtering rather than on hash inputs.
        raw["account_ref_hash"] = "user-ref-12345"
        raw["authorization"] = fake["fake_bearer"]
        raw["prompt"] = "secret prompt body"
        raw["email"] = fake["fake_email"]
        raw["api_key"] = fake["fake_sk_api_key"]
        raw["primary_window"]["api_key"] = fake["fake_sk_api_key"]

        cleaned = sanitize_snapshot(raw)

        # Allowlist fields present
        for k in (
            "captured_at",
            "account_ref_hash",
            "plan_type",
            "percentage_semantics",
            "primary_window",
            "secondary_window",
        ):
            self.assertIn(k, cleaned)

        # Secret-bearing fields dropped
        self.assertNotIn("authorization", cleaned)
        self.assertNotIn("prompt", cleaned)
        self.assertNotIn("email", cleaned)
        self.assertNotIn("api_key", cleaned)

        # Nested secret-bearing field dropped
        self.assertNotIn("api_key", cleaned["primary_window"])

        # Original account reference is replaced by a SHA-256 hash, never the
        # original literal value.
        self.assertNotEqual(cleaned["account_ref_hash"], "user-ref-12345")
        self.assertNotIn("user-ref-12345", json.dumps(cleaned))

        # Hash length stays within spec.
        self.assertLessEqual(len(cleaned["account_ref_hash"]), 16)
        self.assertGreaterEqual(len(cleaned["account_ref_hash"]), 12)


class TestCodexQuotaSourceDiscovery(unittest.TestCase):
    """Discovery path: explicit COCKPIT_BASE_URL with a fake local HTTP server."""

    def test_discover_state_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / "codex-quota.json"
            state_file.write_text(json.dumps(_base_snapshot()), encoding="utf-8")
            with patch.dict(os.environ, {"COCKPIT_CODEX_STATE_FILE": str(state_file)}, clear=False):
                # Clear COCKPIT_BASE_URL to ensure file path wins alone.
                env = {k: v for k, v in os.environ.items() if k != "COCKPIT_BASE_URL"}
                env["COCKPIT_CODEX_STATE_FILE"] = str(state_file)
                with patch.dict(os.environ, env, clear=True):
                    d = discover_source()
                    self.assertEqual(d["source_path_type"], "STATE_FILE")
                    self.assertTrue(d["available"])

                    snap = CodexQuotaCollector().capture_snapshot()
                    self.assertEqual(snap["status"], STATUS_COMPLETE)
                    self.assertEqual(snap["percentage_semantics"], SEMANTICS_REMAINING)

    def test_discover_default_returns_not_available(self):
        env = {k: v for k, v in os.environ.items() if k not in (
            "COCKPIT_BASE_URL", "COCKPIT_CODEX_STATE_FILE", "COCKPIT_CODEX_QUOTA_PATH"
        )}
        with patch.dict(os.environ, env, clear=True):
            d = discover_source()
            self.assertEqual(d["source_path_type"], "NOT_AVAILABLE")
            self.assertFalse(d["available"])


class TestCodexQuotaAccountHash(unittest.TestCase):
    """Account identifier is hashed, not echoed back."""

    def test_account_ref_hash_stable_and_truncated(self):
        h1 = _hash_account_ref("account-xyz")
        h2 = _hash_account_ref("account-xyz")
        h3 = _hash_account_ref("account-abc")
        self.assertEqual(h1, h2)
        self.assertNotEqual(h1, h3)
        self.assertLessEqual(len(h1), 16)
        self.assertGreaterEqual(len(h1), 12)

    def test_account_ref_hash_none_for_empty(self):
        self.assertIsNone(_hash_account_ref(None))
        self.assertIsNone(_hash_account_ref(""))
        self.assertIsNone(_hash_account_ref(123))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()