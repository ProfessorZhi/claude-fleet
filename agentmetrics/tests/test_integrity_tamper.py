"""
Unit tests for payload hash, file hash sidecar, and tamper detection (Exit Code 6).
"""

import json
import tempfile
import shutil
import unittest
from pathlib import Path

from agent_metrics.storage import StorageManager, IntegrityError
from agent_metrics.cli import CLIHandler
from agent_metrics.models import EXIT_INTEGRITY_ERROR


class TestIntegrityTamper(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_summary_tamper_causes_exit_6(self):
        # 1. Start & finish run
        run_id = "11111111-2222-3333-4444-555555555555"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id, json_output=True)

        # 2. Tamper file content (modify work_package)
        run_dir = self.storage.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        with open(summary_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        data["work_package"] = "TAMPERED_WP"
        summary_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

        # 3. Read should raise IntegrityError
        with self.assertRaises(IntegrityError):
            self.storage.read_sanitized_summary(run_id)

        # 4. CLI show should return EXIT_INTEGRITY_ERROR (6)
        exit_code = self.cli.cmd_show(run_id=run_id)
        self.assertEqual(exit_code, EXIT_INTEGRITY_ERROR)

    def test_sidecar_sha256_tamper_causes_exit_6(self):
        run_id = "22222222-3333-4444-5555-666666666666"
        self.storage.create_run({"run_id": run_id, "started_at": "2026-08-01T10:00:00Z", "agent": {"shell": "bash", "provider": "Anthropic"}})
        self.cli.cmd_finish(run_id=run_id, json_output=True)

        # Corrupt sidecar sha256
        run_dir = self.storage.get_run_dir(run_id)
        sha_file = run_dir / "sanitized-summary.sha256"
        sha_file.write_text("0" * 64 + "\n", encoding="utf-8")

        # CLI export should return EXIT_INTEGRITY_ERROR (6)
        out_target = Path(self.temp_dir) / "exported.json"
        exit_code = self.cli.cmd_export(run_id=run_id, output_path=str(out_target))
        self.assertEqual(exit_code, EXIT_INTEGRITY_ERROR)


if __name__ == "__main__":
    unittest.main()
