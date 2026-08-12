import json
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.fleet_boundary import FleetBoundaryError, usage_record_from_summary


def _summary(status="COMPLETE"):
    return {
        "schema_version": 1,
        "collector_version": "0.1.0",
        "run_id": "run-001",
        "work_package": "WP-001",
        "pr_number": None,
        "fleet": {
            "fleet_run_id": "mission-001",
            "fleet_task_id": "task-001",
            "fleet_worker_id": "worker-001",
            "fleet_coordinator_id": "coordinator-001",
            "worker_role": "implementer",
            "worktree_id": "worktree-001",
            "attempt": 1,
        },
        "agent": {
            "shell": "Codex",
            "provider": "OpenAI",
            "configured_model": "gpt-5.3-codex",
            "requested_model": None,
            "observed_model": "gpt-5.3-codex",
            "inferred_model": None,
            "model_detection_source": "fake",
            "model_detection_confidence": "OBSERVED",
            "permission_mode": None,
        },
        "timing": {
            "started_at": "2026-08-09T10:00:00+00:00",
            "finished_at": "2026-08-09T10:00:12+00:00",
            "wall_clock_seconds": 12.0,
            "agent_process_seconds": 10.5,
            "model_event_started_at": None,
            "model_event_finished_at": None,
            "model_event_span_seconds": None,
            "ci_queued_at": None,
            "ci_started_at": None,
            "ci_completed_at": None,
            "ci_queue_seconds": None,
            "ci_run_seconds": None,
            "agent_active_seconds": None,
            "ci_wait_seconds": None,
        },
        "usage": {
            "input_tokens": 120,
            "output_tokens": 45,
            "reasoning_tokens": 15,
            "cache_read_tokens": 10,
            "cache_write_tokens": 5,
            "total_tokens": 165,
            "collection_status": status,
            "source": "codex_exec_json",
            "correlation_confidence": "EXACT_SESSION_AND_CURSOR",
        },
        "pricing": {
            "price_snapshot_date": None,
            "price_source": None,
            "price_snapshot_version": None,
            "currency": "USD",
            "api_equivalent_cost_usd": None,
            "actual_billed_cost_usd": None,
            "status": "USAGE_NOT_AVAILABLE",
        },
        "quota": {
            "before": {
                "percentage_semantics": "remaining",
                "primary_window": {"percentage": 90.0},
            },
            "after": {
                "percentage_semantics": "remaining",
                "primary_window": {"percentage": 80.0},
            },
            "delta": {"primary_consumed_percentage": 10.0},
            "reset_time": "2026-08-09T15:00:00+00:00",
            "subscription_tier": "plus",
            "source": "fake-quota",
        },
        "git": {},
        "github": {},
        "collectors": {},
        "warnings": [],
        "integrity": {"payload_sha256": None},
        "session": {"agent_session_id": "thread-001"},
    }


class FleetUsageBoundaryTests(unittest.TestCase):
    def test_summary_projects_to_usage_record_without_mixing_quota_or_reasoning(self):
        record = usage_record_from_summary(_summary(), usage_id="usage-001")

        self.assertEqual(record["instanceId"], "worker-001")
        self.assertEqual(record["workItemId"], "task-001")
        self.assertEqual(record["sessionId"], "thread-001")
        self.assertEqual(record["runtime"], "codex-cli")
        self.assertEqual(record["durationMs"], 10500)
        self.assertEqual(record["tokens"], {
            "inputTokens": 120,
            "cachedInputTokens": 10,
            "outputTokens": 45,
            "totalTokens": 165,
        })
        self.assertNotIn("reasoningTokens", record["tokens"])
        self.assertNotIn("quota", record)
        self.assertEqual(record["estimateOrActual"], "actual")

    def test_unavailable_usage_cannot_become_fabricated_usage_record(self):
        with self.assertRaisesRegex(FleetBoundaryError, "not publishable"):
            usage_record_from_summary(_summary(status="NOT_AVAILABLE"), usage_id="usage-002")

    def test_turn_cost_and_provider_quota_evidence_stay_separate(self):
        summary = _summary()
        summary["fleet"]["fleet_turn_id"] = "turn-17"
        summary["pricing"]["subscription"] = {
            "amount": 2.5,
            "currency": "USD",
            "basis": "subscription-amortized",
            "plan_type": "Plus",
            "billing_period": "weekly",
            "period_price": 5.0,
            "price_source": "user-entered",
            "fraction_of_period": 0.5,
            "consumed_percentage": 50.0,
            "confidence": "high",
            "availability": "available",
            "estimate_or_actual": "actual",
        }
        summary["quota"]["before"].update({
            "account_ref_hash": "account-001",
            "plan_type": "Plus",
            "primary_window": {"percentage": 90.0, "window_minutes": 10080},
        })
        summary["quota"]["after"].update({
            "account_ref_hash": "account-001",
            "plan_type": "Plus",
            "primary_window": {"percentage": 40.0, "window_minutes": 10080},
        })
        summary["quota"]["delta"].update({"primary_consumed_percentage": 50.0, "delta_status": "COMPLETE"})
        record = usage_record_from_summary(summary, usage_id="usage-turn-17")

        self.assertEqual(record["turnId"], "turn-17")
        self.assertEqual(record["aggregation"], "turn")
        self.assertEqual(record["costs"]["subscription"]["amount"], 2.5)
        self.assertEqual(record["quotaImpact"]["consumedPercentage"], 50.0)
        self.assertEqual(record["quotaImpact"]["window"], "weekly")

    def test_projection_contains_no_raw_summary_or_secret_fields(self):
        summary = _summary()
        summary["prompt"] = "do not publish this prompt"
        summary["agent"]["api_key"] = "sk-test-secret"

        record = usage_record_from_summary(summary, usage_id="usage-003")
        encoded = json.dumps(record, sort_keys=True)
        self.assertNotIn("do not publish", encoded)
        self.assertNotIn("sk-test-secret", encoded)
        self.assertNotIn("fleet_run_id", encoded)


if __name__ == "__main__":
    unittest.main()
