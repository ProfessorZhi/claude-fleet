"""
Unit tests for the Codex Quota Collector.

These tests exercise the semantics-aware delta logic, account privacy,
window-reset handling, the strict schema adapter, and the allowlist
sanitization. They do NOT make any real network request, do NOT touch
real Cockpit state, and do NOT execute any Codex CLI.
"""

import json
import math
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
    SOURCE_COCKPIT_APP_DATA,
    SOURCE_COMPAT_STATE_FILE,
    STATUS_AMBIGUOUS,
    STATUS_COMPLETE,
    STATUS_NOT_AVAILABLE,
    STATUS_PARTIAL,
    STATUS_RESET_DURING_RUN,
    STATUS_SEMANTICS_UNVERIFIED,
    SEMANTICS_REMAINING,
    SEMANTICS_UNKNOWN,
    SEMANTICS_USED,
    _hash_account_ref,
    _is_finite_number,
    _strict_percentage,
    load_cockpit_app_data_snapshot,
    load_compat_state_file_snapshot,
    sanitize_snapshot,
)


def _base_snapshot(**overrides):
    snap = {
        "captured_at": "2026-08-01T10:00:00+00:00",
        "account_ref_hash": "abcdef0123456789",
        "plan_type": "plus",
        "percentage_semantics": SEMANTICS_REMAINING,
        "usage_updated_at": "2026-08-01T09:55:00+00:00",
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


def _cockpit_index(
    *,
    accounts=None,
    current_account_id="acct-real-001",
    extra_account_fields=None,
    extra_quota_fields=None,
):
    """Build a strict Cockpit Codex Account Index for fixtures."""
    if accounts is None:
        quota = {
            "hourly_percentage": 78.0,
            "hourly_reset_time": "2026-08-01T13:00:00+00:00",
            "hourly_window_minutes": 180,
            "weekly_percentage": 92.0,
            "weekly_reset_time": "2026-08-08T10:00:00+00:00",
            "weekly_window_minutes": 10080,
        }
        if extra_quota_fields:
            quota.update(extra_quota_fields)
        acct = {
            "account_id": "acct-real-001",
            "plan_type": "plus",
            "usage_updated_at": "2026-08-01T09:55:00+00:00",
            "quota": quota,
        }
        if extra_account_fields:
            acct.update(extra_account_fields)
        accounts = [acct]
    return {
        "version": 1,
        "current_account_id": current_account_id,
        "accounts": accounts,
    }


class TestCockpitAppDataSchema(unittest.TestCase):
    """Strict Cockpit App Data schema validation."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="amc-cockpit-"))

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _install_index(self, index_data, name="codex_accounts.json"):
        # Write the file under the .antigravity_cockpit/appdata label
        # so the adapter discovers it via LOCALAPPDATA / APPDATA probing.
        path = self.tmpdir / name
        path.write_text(json.dumps(index_data), encoding="utf-8")
        return path

    def _roots_with_fixture(self):
        """Patch _candidate_app_data_roots so the adapter walks our tmpdir."""
        return patch(
            "agent_metrics.collectors.codex_quota_collector._candidate_app_data_roots",
            return_value=[("test-fixture", self.tmpdir)],
        )

    # --- 1. Real Cockpit CodexAccount Schema mapping ---------------------
    def test_real_cockpit_schema_maps_to_canonical_fields(self):
        index = _cockpit_index()
        # Write the fixture index so the adapter discovers it.
        self.tmpdir.joinpath("codex_accounts.json").write_text(
            json.dumps(index), encoding="utf-8"
        )
        with self._roots_with_fixture():
            snap, source, reason = load_cockpit_app_data_snapshot()

        self.assertEqual(source, SOURCE_COCKPIT_APP_DATA,
                         f"expected cockpit_app_data, got {source} (reason={reason})")
        self.assertIsInstance(snap, dict)
        self.assertEqual(snap["status"], STATUS_COMPLETE)
        self.assertEqual(snap["percentage_semantics"], SEMANTICS_REMAINING)
        self.assertIn("account_ref_hash", snap)
        self.assertEqual(snap["plan_type"], "plus")
        self.assertEqual(snap["primary_window"]["percentage"], 78.0)
        self.assertEqual(snap["primary_window"]["window_minutes"], 180)
        self.assertEqual(snap["secondary_window"]["percentage"], 92.0)
        # Raw account_id NOT persisted
        self.assertNotIn("acct-real-001", json.dumps(snap))

    # --- 2. current_account_id selects the correct account --------------
    def test_current_account_id_selects_correct_account(self):
        acct_a = {
            "account_id": "acct-a",
            "plan_type": "free",
            "usage_updated_at": "2026-08-01T09:00:00+00:00",
            "quota": {
                "hourly_percentage": 10.0,
                "hourly_reset_time": "2026-08-01T11:00:00+00:00",
                "hourly_window_minutes": 60,
                "weekly_percentage": 10.0,
                "weekly_reset_time": "2026-08-02T11:00:00+00:00",
                "weekly_window_minutes": 10080,
            },
        }
        acct_b = {
            "account_id": "acct-b",
            "plan_type": "pro",
            "usage_updated_at": "2026-08-01T09:30:00+00:00",
            "quota": {
                "hourly_percentage": 50.0,
                "hourly_reset_time": "2026-08-01T11:00:00+00:00",
                "hourly_window_minutes": 60,
                "weekly_percentage": 60.0,
                "weekly_reset_time": "2026-08-02T11:00:00+00:00",
                "weekly_window_minutes": 10080,
            },
        }
        index = {
            "version": 1,
            "current_account_id": "acct-b",
            "accounts": [acct_a, acct_b],
        }
        self.tmpdir.joinpath("codex_accounts.json").write_text(
            json.dumps(index), encoding="utf-8"
        )
        with self._roots_with_fixture():
            snap, source, _ = load_cockpit_app_data_snapshot()

        self.assertEqual(source, SOURCE_COCKPIT_APP_DATA)
        self.assertEqual(snap["account_ref_hash"], _hash_account_ref("OpenAI:acct-b"))
        self.assertEqual(snap["primary_window"]["percentage"], 50.0)
        self.assertEqual(snap["plan_type"], "pro")

    # --- 3. Multi-account without current_account_id -> NOT_AVAILABLE ----
    def test_multi_account_without_current_account_id_not_available(self):
        index = _cockpit_index(current_account_id=None)
        index["accounts"] = index["accounts"] + [{
            "account_id": "acct-extra",
            "plan_type": "free",
            "usage_updated_at": "2026-08-01T09:00:00+00:00",
            "quota": {
                "hourly_percentage": 0.0,
                "hourly_reset_time": "2026-08-01T11:00:00+00:00",
                "hourly_window_minutes": 60,
                "weekly_percentage": 0.0,
                "weekly_reset_time": "2026-08-02T11:00:00+00:00",
                "weekly_window_minutes": 10080,
            },
        }]
        self.tmpdir.joinpath("codex_accounts.json").write_text(
            json.dumps(index), encoding="utf-8"
        )
        with self._roots_with_fixture():
            snap, source, reason = load_cockpit_app_data_snapshot()

        self.assertIsNone(snap)
        self.assertEqual(source, "NOT_AVAILABLE")
        self.assertIn("current_account_id", reason)

    # --- 4. Empty JSON must NOT be COMPLETE ------------------------------
    def test_empty_json_object_not_complete(self):
        with self._roots_with_fixture():
            snap, source, reason = load_cockpit_app_data_snapshot()
        self.assertIsNone(snap)
        self.assertEqual(source, "NOT_AVAILABLE")
        self.assertIn("no_cockpit_app_data_file_found", reason)

    # --- 5. Missing quota must NOT be COMPLETE ---------------------------
    def test_missing_quota_not_complete(self):
        index = _cockpit_index()
        index["accounts"][0].pop("quota")
        path = self.tmpdir / "codex_accounts.json"
        path.write_text(json.dumps(index), encoding="utf-8")
        with self._roots_with_fixture():
            snap, source, reason = load_cockpit_app_data_snapshot()
        self.assertIsNotNone(snap)
        self.assertEqual(source, SOURCE_COCKPIT_APP_DATA)
        self.assertEqual(snap["status"], STATUS_PARTIAL)
        self.assertIsNone(snap["primary_window"]["percentage"])
        self.assertEqual(reason, "ok")

    # --- 6. Bad percentage values rejected --------------------------------
    def test_bad_percentage_values_rejected(self):
        bad_values = [
            ("bool", True),
            ("nan", math.nan),
            ("infinity", math.inf),
            ("negative", -5.0),
            ("greater_than_100", 150.0),
            ("string", "abc"),
        ]
        for label, bad in bad_values:
            with self.subTest(label=label):
                index = _cockpit_index(extra_quota_fields={"hourly_percentage": bad})
                path = self.tmpdir / f"codex_accounts_{label}.json"
                path.write_text(json.dumps(index), encoding="utf-8")
                with self._roots_with_fixture():
                    snap, source, reason = load_cockpit_app_data_snapshot()
                self.assertNotEqual(source, SOURCE_COCKPIT_APP_DATA,
                                     f"Bad percentage {label} must not yield cockpit_app_data")
                if source != "NOT_AVAILABLE":
                    self.fail(f"Unexpected source for {label}: {source} (reason={reason})")

    # --- 7. Real Cockpit file absent on host -> NOT_AVAILABLE ------------
    def test_real_cockpit_app_data_absent_not_available(self):
        # No patches, no COMPAT_STATE_FILE -> must report NOT_AVAILABLE.
        env = {k: v for k, v in os.environ.items() if k != "COMPAT_STATE_FILE"}
        with patch.dict(os.environ, env, clear=True), patch(
            "agent_metrics.collectors.codex_quota_collector._candidate_app_data_roots",
            return_value=[],
        ):
            collector = CodexQuotaCollector()
            self.assertEqual(collector.get_status(), "NOT_AVAILABLE")
            snap = collector.capture_snapshot()
            self.assertEqual(snap["status"], STATUS_NOT_AVAILABLE)
            # No false source tag
            self.assertNotEqual(snap.get("source"), SOURCE_COCKPIT_APP_DATA)
            self.assertNotEqual(snap.get("source"), SOURCE_COMPAT_STATE_FILE)


class TestCockpitCompatStateFile(unittest.TestCase):
    """COMPAT_STATE_FILE is the only non-Cockpit path and never claims provenance."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="amc-compat-"))

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_compat_state_file_loads_with_compat_tag(self):
        snap_dict = _base_snapshot()
        # Strip the internal hash so sanitize_snapshot hashes the raw input.
        snap_dict_for_file = dict(snap_dict)
        snap_dict_for_file["account_ref_hash"] = "compat-account-ref"
        path = self.tmpdir / "compat.json"
        path.write_text(json.dumps(snap_dict_for_file), encoding="utf-8")
        with patch.dict(os.environ, {"COMPAT_STATE_FILE": str(path)}):
            snap, source, _ = load_compat_state_file_snapshot()
        self.assertEqual(source, SOURCE_COMPAT_STATE_FILE)
        self.assertEqual(snap["status"], STATUS_COMPLETE)
        # NEVER tagged as the real Cockpit source
        self.assertNotEqual(snap.get("source"), SOURCE_COCKPIT_APP_DATA)


class TestCodexQuotaDeltaValidation(unittest.TestCase):
    """Strict delta validation per the reviewer's contract."""

    def test_missing_account_ref_hash_is_ambiguous(self):
        # Both snapshots have no account_ref_hash -> AMBIGUOUS, null delta.
        before = _base_snapshot()
        before["account_ref_hash"] = None
        after = _base_snapshot()
        after["account_ref_hash"] = None
        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["delta_status"], STATUS_AMBIGUOUS)
        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertIsNone(delta["secondary_consumed_percentage"])

    def test_before_after_semantics_mismatch_is_unverified(self):
        before = _base_snapshot(percentage_semantics=SEMANTICS_REMAINING)
        after = _base_snapshot(percentage_semantics=SEMANTICS_USED)
        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["delta_status"], STATUS_SEMANTICS_UNVERIFIED)
        self.assertIsNone(delta["primary_consumed_percentage"])

    def test_negative_delta_remaining_is_ambiguous(self):
        # remaining semantics: a *rise* in percentage means LESS consumed,
        # which the spec forbids from being silently abs()'d.
        before = _base_snapshot(percentage_semantics=SEMANTICS_REMAINING)
        before["primary_window"]["percentage"] = 50.0
        after = _base_snapshot(percentage_semantics=SEMANTICS_REMAINING)
        after["primary_window"]["percentage"] = 70.0  # went UP, not down

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["primary_status"], STATUS_AMBIGUOUS)
        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertEqual(delta["delta_status"], STATUS_AMBIGUOUS)

    def test_negative_delta_used_is_ambiguous(self):
        before = _base_snapshot(percentage_semantics=SEMANTICS_USED)
        before["primary_window"]["percentage"] = 50.0
        after = _base_snapshot(percentage_semantics=SEMANTICS_USED)
        after["primary_window"]["percentage"] = 30.0  # went DOWN, not up

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["primary_status"], STATUS_AMBIGUOUS)
        self.assertIsNone(delta["primary_consumed_percentage"])

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

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertAlmostEqual(delta["primary_consumed_percentage"], 10.0)
        self.assertAlmostEqual(delta["secondary_consumed_percentage"], 5.0)
        self.assertEqual(delta["delta_status"], STATUS_COMPLETE)

    def test_unknown_semantics_no_delta(self):
        before = _base_snapshot(percentage_semantics=SEMANTICS_UNKNOWN)
        after = _base_snapshot(percentage_semantics=SEMANTICS_UNKNOWN)
        after["primary_window"]["percentage"] = 50.0

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertIsNone(delta["secondary_consumed_percentage"])
        self.assertEqual(delta["primary_status"], STATUS_SEMANTICS_UNVERIFIED)
        self.assertEqual(delta["delta_status"], STATUS_SEMANTICS_UNVERIFIED)

    def test_primary_window_reset_returns_reset_status(self):
        before = _base_snapshot()
        after = _base_snapshot()
        after["primary_window"]["reset_at"] = "2026-08-01T14:00:00+00:00"
        after["secondary_window"]["reset_at"] = "2026-08-08T10:00:00+00:00"
        after["secondary_window"]["percentage"] = 88.0

        delta = CodexQuotaCollector().calculate_delta(before, after)
        self.assertEqual(delta["primary_status"], STATUS_RESET_DURING_RUN)
        self.assertIsNone(delta["primary_consumed_percentage"])
        self.assertEqual(delta["secondary_status"], STATUS_COMPLETE)
        self.assertAlmostEqual(delta["secondary_consumed_percentage"], 2.0)
        self.assertEqual(delta["delta_status"], STATUS_RESET_DURING_RUN)


class TestCodexQuotaStrictValidators(unittest.TestCase):
    """Pure validation helpers — no I/O."""

    def test_strict_percentage_rejects_non_finite(self):
        self.assertIsNone(_strict_percentage(math.nan))
        self.assertIsNone(_strict_percentage(math.inf))
        self.assertIsNone(_strict_percentage(-math.inf))
        self.assertIsNone(_strict_percentage(True))
        self.assertIsNone(_strict_percentage(False))
        self.assertIsNone(_strict_percentage("80"))
        self.assertIsNone(_strict_percentage(None))
        self.assertIsNone(_strict_percentage({}))

    def test_strict_percentage_rejects_out_of_range(self):
        # NO clamping: out-of-range values are rejected outright.
        self.assertIsNone(_strict_percentage(-0.01))
        self.assertIsNone(_strict_percentage(100.01))
        self.assertEqual(_strict_percentage(0.0), 0.0)
        self.assertEqual(_strict_percentage(100.0), 100.0)
        self.assertEqual(_strict_percentage(80.5), 80.5)

    def test_is_finite_number_strict(self):
        self.assertFalse(_is_finite_number(True))
        self.assertFalse(_is_finite_number(False))
        self.assertFalse(_is_finite_number("1"))
        self.assertFalse(_is_finite_number(None))
        self.assertFalse(_is_finite_number(math.nan))
        self.assertFalse(_is_finite_number(math.inf))
        self.assertTrue(_is_finite_number(0))
        self.assertTrue(_is_finite_number(0.0))
        self.assertTrue(_is_finite_number(-0.0))
        self.assertTrue(_is_finite_number(42.5))


class TestCodexQuotaSnapshotAllowlist(unittest.TestCase):
    """Allowlist filtering drops secret-bearing fields."""

    def setUp(self):
        self.fake = json.loads(
            (Path(__file__).resolve().parent / "fixtures" / "known-fake-secrets" / "fake_secrets.json").read_text(
                encoding="utf-8"
            )
        )

    def test_snapshot_allowlist_excludes_secrets(self):
        raw = _base_snapshot()
        raw["account_ref_hash"] = "user-ref-12345"
        raw["authorization"] = self.fake["fake_bearer"]
        raw["prompt"] = "secret prompt body"
        raw["email"] = self.fake["fake_email"]
        raw["api_key"] = self.fake["fake_sk_api_key"]
        raw["primary_window"]["api_key"] = self.fake["fake_sk_api_key"]

        cleaned = sanitize_snapshot(raw)

        for k in (
            "captured_at",
            "account_ref_hash",
            "plan_type",
            "percentage_semantics",
            "primary_window",
            "secondary_window",
        ):
            self.assertIn(k, cleaned)

        self.assertNotIn("authorization", cleaned)
        self.assertNotIn("prompt", cleaned)
        self.assertNotIn("email", cleaned)
        self.assertNotIn("api_key", cleaned)
        self.assertNotIn("api_key", cleaned["primary_window"])

        self.assertNotEqual(cleaned["account_ref_hash"], "user-ref-12345")
        self.assertNotIn("user-ref-12345", json.dumps(cleaned))

        self.assertLessEqual(len(cleaned["account_ref_hash"]), 16)
        self.assertGreaterEqual(len(cleaned["account_ref_hash"]), 12)


class TestAccountRefHash(unittest.TestCase):
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
