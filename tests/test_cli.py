import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.cli import CLIHandler
from agent_metrics.storage import StorageManager
from agent_metrics.models import EXIT_OK, EXIT_INVALID_INPUT, EXIT_STORAGE_ERROR, EXIT_PARTIAL


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


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = StorageManager(base_dir=self.temp_dir)
        self.cli = CLIHandler(storage_manager=self.storage)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # Test 1: doctor JSON output
    def test_doctor_json_output(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_doctor(json_output=True)
            output = fake_out.getvalue()
            data = json.loads(output)
            self.assertIn("version", data)
            self.assertIn("python_version", data)
            self.assertIn("git", data)
            self.assertIn("github_cli", data)
            self.assertIn("cockpit", data)

    # Test 2: start creates Run directory and run-context.json
    def test_start_creates_run(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_start(
                agent_shell="Claude-Code",
                provider="DeepSeek",
                configured_model="deepseek-v4-flash",
                work_package="WP-TEST-01",
                pr_number=60,
                json_output=True,
            )
            self.assertEqual(code, EXIT_OK)
            run_id = extract_run_id(fake_out.getvalue())
            self.assertTrue(Path(self.temp_dir, run_id, "run-context.json").exists())

    # Test 3: start output contains RUN_ID=<UUID>
    def test_start_outputs_run_id_line(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            code = self.cli.cmd_start(
                agent_shell="Antigravity",
                provider="Google",
                configured_model="gemini-3.6-flash",
                work_package="AG-TEST-01",
                json_output=False,
            )
            self.assertEqual(code, EXIT_OK)
            output = fake_out.getvalue()
            self.assertIn("RUN_ID=", output)
            self.assertIn('$env:ZUNO_AGENT_RUN_ID="', output)

    # Test 4: finish updates finished_at and wall_clock_seconds
    def test_finish_updates_finished_at(self):
        # Start first
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        with patch("sys.stdout", new=io.StringIO()) as fake_fin_out:
            code = self.cli.cmd_finish(run_id=run_id, json_output=True)
            self.assertEqual(code, EXIT_OK)
            out_str = fake_fin_out.getvalue()
            summary = json.loads(out_str[out_str.find("{"):out_str.rfind("}")+1])
            self.assertIsNotNone(summary["timing"]["finished_at"])
            self.assertIsNotNone(summary["timing"]["wall_clock_seconds"])
            self.assertGreaterEqual(summary["timing"]["wall_clock_seconds"], 0.0)

    # Test 5: reconcile without gh gracefully handles missing PR or returns partial status
    def test_reconcile_without_gh(self):
        with patch("sys.stdout", new=io.StringIO()):
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic", pr_number=123)
            ctx_id = list(Path(self.temp_dir).glob("*"))[0].name

        # Mock gh CLI missing
        with patch("shutil.which", return_value=None):
            code = self.cli.cmd_reconcile(run_id=ctx_id, pr_number=123)
            self.assertEqual(code, EXIT_OK)
            summary = self.storage.read_sanitized_summary(ctx_id)
            self.assertEqual(summary["pr_number"], 123)
            self.assertIn("github", summary)

    # Test 6: export JSON format
    def test_export_json_format(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = extract_run_id(fake_start_out.getvalue())

        self.cli.cmd_finish(run_id=run_id)
        export_file = Path(self.temp_dir, "export.json")
        code = self.cli.cmd_export(run_id=run_id, format_type="json", output_path=str(export_file))
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(export_file.exists())
        data = json.loads(export_file.read_text(encoding="utf-8"))
        self.assertEqual(data["run_id"], run_id)

    # Test 7: export Zuno PR Record Fragment format
    def test_export_zuno_fragment_format(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic", work_package="WP-007")
            run_id = extract_run_id(fake_start_out.getvalue())

        self.cli.cmd_finish(run_id=run_id)
        export_file = Path(self.temp_dir, "zuno_fragment.json")
        code = self.cli.cmd_export(run_id=run_id, format_type="zuno-pr-record-fragment", output_path=str(export_file))
        self.assertEqual(code, EXIT_OK)
        data = json.loads(export_file.read_text(encoding="utf-8"))
        self.assertEqual(data["schema_version"], "zuno-pr-record-fragment-v1")
        self.assertEqual(data["work_package"], "WP-007")

    # Test 8: unknown run_id handling
    def test_unknown_run_id(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_finish(run_id="non-existent-uuid", json_output=False)
            self.assertEqual(code, EXIT_STORAGE_ERROR)

    # Test 9: invalid parameters handling
    def test_invalid_parameters(self):
        with patch("sys.stderr", new=io.StringIO()):
            code = self.cli.cmd_start(agent_shell="", provider="")
            self.assertEqual(code, EXIT_INVALID_INPUT)

    # Test 10: repeated finish is idempotent
    def test_finish_idempotency(self):
        with patch("sys.stdout", new=io.StringIO()) as fake_start_out:
            self.cli.cmd_start(agent_shell="Claude-Code", provider="Anthropic")
            run_id = fake_start_out.getvalue().split("RUN_ID=")[1].strip()

        self.cli.cmd_finish(run_id=run_id)
        s1 = self.storage.read_sanitized_summary(run_id)

        self.cli.cmd_finish(run_id=run_id)
        s2 = self.storage.read_sanitized_summary(run_id)

        self.assertEqual(s1["timing"]["started_at"], s2["timing"]["started_at"])
        self.assertEqual(s1["run_id"], s2["run_id"])


if __name__ == "__main__":
    unittest.main()
