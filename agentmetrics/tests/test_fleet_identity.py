import unittest

from agent_metrics.models import AgentInfo, SanitizedSummary
from agent_metrics.validators import validate_fleet_identity, validate_run_context, validate_sanitized_summary


class FleetIdentityContractTests(unittest.TestCase):
    def test_accepts_safe_identity(self):
        validate_fleet_identity(
            {
                "fleet_run_id": "run-001",
                "fleet_task_id": "task.telemetry",
                "fleet_worker_id": "worker_a",
                "worker_role": "implementer",
                "attempt": 1,
            }
        )

    def test_rejects_path_or_prompt_content(self):
        with self.assertRaises(ValueError):
            validate_fleet_identity({"worktree_id": "F:\\repo\\worker"})
        with self.assertRaises(ValueError):
            validate_fleet_identity({"worker_role": "reviewer\nsecret"})

    def test_rejects_non_positive_attempt(self):
        with self.assertRaises(ValueError):
            validate_fleet_identity({"attempt": 0})

    def test_optional_fleet_metadata_round_trips_in_context_and_summary(self):
        fleet = {"fleet_run_id": "run-001", "fleet_worker_id": "worker-1"}
        validate_run_context(
            {
                "collector_version": "0.1.0",
                "run_id": "run-001",
                "started_at": "2026-08-09T00:00:00+00:00",
                "agent": {"shell": "Codex", "provider": "OpenAI"},
                "fleet": fleet,
            }
        )
        summary = SanitizedSummary(
            run_id="run-001",
            fleet=fleet,
            agent=AgentInfo(shell="Codex", provider="OpenAI"),
        ).to_dict()
        self.assertEqual(summary["fleet"], fleet)
        validate_sanitized_summary(summary)


if __name__ == "__main__":
    unittest.main()
