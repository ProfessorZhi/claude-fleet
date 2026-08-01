import json
import tempfile
import unittest
from pathlib import Path

from agent_metrics.collectors.codex_exec_json_collector import CodexExecJsonCollector


class TestCodexExecJsonCollector(unittest.TestCase):
    def test_turn_completed_usage_mapping_and_dedupe(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "codex.jsonl"
            event = {
                "event_id": "evt-1",
                "thread_id": "thread-a",
                "turn_ordinal": 1,
                "timestamp": "2026-08-01T00:00:01Z",
                "model": "gpt-5.3-codex",
                "prompt": "must not persist",
                "usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 30,
                    "cache_write_input_tokens": 20,
                    "output_tokens": 40,
                    "reasoning_output_tokens": 10,
                },
            }
            p.write_text(json.dumps(event) + "\n" + json.dumps(event) + "\n", encoding="utf-8")

            res = CodexExecJsonCollector({"json_log_path": str(p)}).collect()

            self.assertEqual(res["status"], "COMPLETE")
            self.assertEqual(res["turn_count"], 1)
            self.assertEqual(res["usage"]["input_tokens"], 100)
            self.assertEqual(res["usage"]["cache_read_tokens"], 30)
            self.assertEqual(res["usage"]["cache_write_tokens"], 20)
            self.assertEqual(res["usage"]["output_tokens"], 40)
            self.assertEqual(res["usage"]["reasoning_tokens"], 10)
            self.assertNotIn("prompt", json.dumps(res))

    def test_failure_stream_keeps_observed_usage(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "codex.jsonl"
            p.write_text(
                json.dumps({
                    "thread_id": "thread-a",
                    "turn_ordinal": 1,
                    "timestamp": "2026-08-01T00:00:01Z",
                    "usage": {"input_tokens": 1, "output_tokens": 2},
                })
                + "\n{bad json\n",
                encoding="utf-8",
            )

            res = CodexExecJsonCollector({"json_log_path": str(p)}).collect()

            self.assertEqual(res["status"], "PARTIAL")
            self.assertEqual(res["usage"]["collection_status"], "PARTIAL")
            self.assertEqual(res["usage"]["total_tokens"], 3)


if __name__ == "__main__":
    unittest.main()
