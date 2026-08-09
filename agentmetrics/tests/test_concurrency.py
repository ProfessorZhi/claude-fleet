import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.cli import CLIHandler
from agent_metrics.storage import StorageManager
from agent_metrics.models import EXIT_OK


def extract_run_id(output: str) -> str:
    m = re.search(r"^RUN_ID=([a-f0-9\-]+)$", output, re.MULTILINE | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m2 = re.search(r'ZUNO_AGENT_RUN_ID="([a-f0-9\-]+)"', output, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    if "{" in output:
        try:
            s_idx = output.find("{")
            e_idx = output.rfind("}") + 1
            data = json.loads(output[s_idx:e_idx])
            return str(data.get("run_id", "")).strip('"\' \n\r')
        except Exception:
            pass
    return ""


class TestConcurrency(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_concurrent_three_runs_isolation(self):
        run_ids = []
        # Create 3 concurrent runs
        for i in range(1, 4):
            with patch("sys.stdout", new=io.StringIO()) as fake_start:
                code = self.cli.cmd_start(
                    agent_shell="Claude-Code",
                    provider="DeepSeek",
                    configured_model="deepseek-v4-flash",
                    work_package=f"CONCURRENT-WP-0{i}",
                    worktree=f"F:\\worktrees\\wt_{i}",
                    json_output=True,
                )
                self.assertEqual(code, EXIT_OK)
                r_id = extract_run_id(fake_start.getvalue())
                run_ids.append(r_id)

        # Ensure 3 distinct directories exist
        self.assertEqual(len(set(run_ids)), 3)
        for r_id in run_ids:
            self.assertTrue(Path(self.temp_dir, r_id, "run-context.json").exists())

        # Finish all 3 runs
        for r_id in run_ids:
            code = self.cli.cmd_finish(run_id=r_id)
            self.assertEqual(code, EXIT_OK)

        # Verify summary isolation
        for idx, r_id in enumerate(run_ids, 1):
            summary = self.storage.read_sanitized_summary(r_id)
            self.assertEqual(summary["work_package"], f"CONCURRENT-WP-0{idx}")
            self.assertEqual(summary["run_id"], r_id)


if __name__ == "__main__":
    unittest.main()
