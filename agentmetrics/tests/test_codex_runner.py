"""
Integration tests for the Codex PowerShell runner.

Scenarios 12-14:
    - Fake Codex Exit 0 propagates; Runner returns 0.
    - Fake Codex non-zero exit propagates; Runner returns that exit code.
    - Codex failure still triggers Finish (sanitized-summary.json exists).

The runner is invoked via PowerShell. The "fake codex" process is a tiny
``.cmd`` shim written to a temp directory and pointed at via a unique shim
name (``fake-codex``) so the real ``codex.exe`` on PATH is never hit.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.fleet_boundary import usage_record_from_summary


RUNNER = REPO_ROOT / "scripts" / "run-codex-with-metrics.ps1"
LOCAL_RUNS_ROOT = REPO_ROOT / ".local" / "runs"


def _which_powershell():
    for candidate in ("powershell", "pwsh"):
        found = shutil.which(candidate)
        if found:
            return found
    raise RuntimeError("PowerShell is required to exercise run-codex-with-metrics.ps1")


def _make_named_fake_codex_dir(exit_code: int, stdout_line: str):
    """Create a temp directory containing ``fake-codex.cmd``.

    The shim is named ``fake-codex`` (not ``codex``) to ensure the runner
    never accidentally invokes the real ``codex.exe`` that lives on PATH.
    Returns ``(directory, shim_basename)``.
    """
    d = Path(tempfile.mkdtemp(prefix="amc-fake-codex-"))
    shim_basename = "fake-codex"
    shim_path = d / (shim_basename + ".cmd")
    body = textwrap.dedent(
        f"""
        @echo off
        echo {stdout_line}
        exit /b {exit_code}
        """
    ).strip() + "\n"
    shim_path.write_text(body, encoding="utf-8")
    return d, shim_basename


def _make_json_fake_codex_dir(events, exit_code: int = 0):
    """Create a fake Codex that emits deterministic ``exec --json`` events."""
    d = Path(tempfile.mkdtemp(prefix="amc-fake-codex-json-"))
    shim_basename = "fake-codex-json"
    shim_path = d / (shim_basename + ".cmd")
    lines = [
        "@echo off",
        *[f"echo {json.dumps(event, separators=(',', ':'))}" for event in events],
        f"exit /b {exit_code}",
    ]
    shim_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return d, shim_basename


class TestCodexRunner(unittest.TestCase):
    """Exercise the Codex PowerShell wrapper using a fake codex executable.

    The runner is a Windows PowerShell script that shells out to
    ``powershell`` itself. On non-Windows hosts the nested invocation is
    unreliable, so the whole class is skipped.
    """

    @classmethod
    def setUpClass(cls):
        if os.name != "nt":
            raise unittest.SkipTest(
                "run-codex-with-metrics.ps1 is a Windows-only runner; "
                "non-Windows hosts are not supported."
            )
        if not RUNNER.exists():
            raise unittest.SkipTest(f"Runner not present at {RUNNER}")
        try:
            cls.powershell = _which_powershell()
        except RuntimeError:
            raise unittest.SkipTest("PowerShell is not installed on this host")

    def setUp(self):
        # Per-test skip if PowerShell is unavailable. The runner itself is
        # a Windows-only artifact.
        if not getattr(self, "powershell", None):
            self.skipTest("PowerShell is not installed on this host")

    def tearDown(self):
        # Clean up .local/runs directories created during this test, leaving
        # behind any unrelated runs from earlier work. We only delete dirs
        # that look like a freshly-created UUID from THIS test invocation.
        if LOCAL_RUNS_ROOT.exists():
            for run_dir in LOCAL_RUNS_ROOT.iterdir():
                if not run_dir.is_dir():
                    continue
                name = run_dir.name
                # UUID-shaped directory names only.
                try:
                    uuid.UUID(name)
                except Exception:
                    continue
                # Heuristic: the directory must contain sanitized-summary.json
                # AND must be reasonably fresh (modified in the last hour).
                summary_file = run_dir / "sanitized-summary.json"
                if not summary_file.exists():
                    continue
                try:
                    import time
                    if (time.time() - summary_file.stat().st_mtime) > 3600:
                        continue
                except Exception:
                    continue
                shutil.rmtree(run_dir, ignore_errors=True)

    def _run_runner(self, worktree, fake_dir, fake_basename, work_package, extra_args=None):
        env = os.environ.copy()
        env["PATH"] = str(fake_dir) + os.pathsep + env.get("PATH", "")
        # Use a unique work-package per run so the .local/runs tree stays
        # observable per-test and we can clean it up after each test.
        command = [
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", str(RUNNER),
                "-WorkPackage", work_package,
                "-Worktree", str(worktree),
                "-CodexCommand", fake_basename,
                "fake-arg-1",
            ]
        if extra_args:
            command[command.index("fake-arg-1"):command.index("fake-arg-1")] = extra_args
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        return proc

    @staticmethod
    def _summary_path(stdout):
        for line in stdout.splitlines():
            if line.startswith("SUMMARY_PATH="):
                return Path(line[len("SUMMARY_PATH="):].strip())
        return None

    def _make_worktree(self):
        return Path(tempfile.mkdtemp(prefix="amc-runner-"))

    def test_fake_codex_exit_zero_propagates(self):
        worktree = self._make_worktree()
        fake_dir, fake_basename = _make_named_fake_codex_dir(0, "fake-codex-ok")
        try:
            proc = self._run_runner(worktree, fake_dir, fake_basename, "WP-CODEX-RUNNER-OK")
            self.assertEqual(
                proc.returncode, 0,
                msg=f"Expected exit 0; got {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
            )
            self.assertIn("RUN_ID=", proc.stdout)
            self.assertIn("SUMMARY_PATH=", proc.stdout)
            self.assertNotIn("fake-codex-ok", proc.stdout)
            self.assertIn("AGENT_EXIT_CODE=0", proc.stdout)
        finally:
            shutil.rmtree(worktree, ignore_errors=True)
            shutil.rmtree(fake_dir, ignore_errors=True)

    def test_fake_codex_nonzero_exit_propagates(self):
        worktree = self._make_worktree()
        fake_dir, fake_basename = _make_named_fake_codex_dir(3, "fake-codex-failed")
        try:
            proc = self._run_runner(worktree, fake_dir, fake_basename, "WP-CODEX-RUNNER-FAIL")
            self.assertEqual(
                proc.returncode, 3,
                msg=f"Expected exit 3; got {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
            )
            self.assertIn("RUN_ID=", proc.stdout)
            self.assertIn("SUMMARY_PATH=", proc.stdout)
            self.assertNotIn("fake-codex-failed", proc.stdout)
            self.assertIn("AGENT_EXIT_CODE=3", proc.stdout)

            # Finish MUST have run even though Codex failed. The summary
            # lives at <repo_root>/.local/runs/<run_id>/sanitized-summary.json
            # because that is StorageManager's base_dir. The runner prints the
            # exact path on stdout via SUMMARY_PATH=... — use it to confirm.
            match = None
            for line in proc.stdout.splitlines():
                if line.startswith("SUMMARY_PATH="):
                    match = line[len("SUMMARY_PATH="):].strip()
                    break
            self.assertIsNotNone(match, "Runner did not emit SUMMARY_PATH=")
            self.assertTrue(
                os.path.isfile(match),
                f"Runner reported SUMMARY_PATH={match} but the file does not exist.",
            )
        finally:
            shutil.rmtree(worktree, ignore_errors=True)
            shutil.rmtree(fake_dir, ignore_errors=True)

    def test_fake_codex_fleet_identity_usage_and_quota_boundary(self):
        """Exercise Fleet identity -> runner -> summary -> UsageRecord.

        The fake emits fixed usage values and a fixed thread id.  No provider
        process or API is contacted.  Quota remains a separate account-level
        snapshot and is never folded into tokens or duration.
        """
        worktree = self._make_worktree()
        fake_dir, fake_basename = _make_json_fake_codex_dir([
            {
                "type": "turn.completed",
                "event_id": "evt-fleet-001",
                "thread_id": "thread-fleet-001",
                "turn_ordinal": 1,
                "timestamp": "2026-08-09T10:00:01Z",
                "model": "gpt-5.3-codex",
                "prompt": "must not persist",
                "api_key": "sk-test-secret",
                "usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 10,
                    "cache_write_input_tokens": 5,
                    "output_tokens": 45,
                    "reasoning_output_tokens": 15,
                },
            }
        ])
        fleet_args = [
            "-FleetRunId", "mission-fake-001",
            "-FleetTaskId", "task-fake-001",
            "-FleetWorkerId", "worker-fake-001",
            "-FleetCoordinatorId", "coordinator-fake-001",
            "-ParentWorkerId", "worker-parent-001",
            "-WorkerRole", "implementer",
            "-WorktreeId", "worktree-fake-001",
            "-Attempt", "2",
        ]
        try:
            proc = self._run_runner(
                worktree,
                fake_dir,
                fake_basename,
                "WP-FLEET-BOUNDARY",
                extra_args=fleet_args,
            )
            self.assertEqual(
                proc.returncode,
                0,
                msg=f"Expected exit 0; got {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
            )
            summary_path = self._summary_path(proc.stdout)
            self.assertIsNotNone(summary_path, "Runner did not emit SUMMARY_PATH=")
            self.assertTrue(summary_path.is_file(), f"Missing summary: {summary_path}")
            summary = json.loads(summary_path.read_text(encoding="utf-8"))

            self.assertEqual(summary["fleet"], {
                "fleet_run_id": "mission-fake-001",
                "fleet_task_id": "task-fake-001",
                "fleet_worker_id": "worker-fake-001",
                "fleet_coordinator_id": "coordinator-fake-001",
                "parent_worker_id": "worker-parent-001",
                "worker_role": "implementer",
                "worktree_id": "worktree-fake-001",
                "attempt": 2,
            })
            self.assertEqual(summary["usage"]["collection_status"], "COMPLETE")
            self.assertEqual(summary["usage"]["input_tokens"], 120)
            self.assertEqual(summary["usage"]["output_tokens"], 45)
            self.assertEqual(summary["usage"]["reasoning_tokens"], 15)
            self.assertEqual(summary["usage"]["cache_read_tokens"], 10)
            self.assertEqual(summary["usage"]["cache_write_tokens"], 5)
            # total_tokens is input + output; cache/reasoning buckets are not
            # added again because they are sub-buckets, not extra requests.
            self.assertEqual(summary["usage"]["total_tokens"], 165)
            self.assertEqual(summary["session"]["agent_session_id"], "thread-fleet-001")
            self.assertGreaterEqual(summary["timing"]["agent_process_seconds"], 0.0)

            quota_json = json.dumps(summary["quota"], sort_keys=True)
            self.assertEqual(summary["quota"]["scope"], "ACCOUNT")
            self.assertEqual(summary["quota"]["attribution"], "NOT_PROVEN")
            self.assertNotIn("total_tokens", quota_json)
            self.assertNotIn("input_tokens", quota_json)
            self.assertNotIn("output_tokens", quota_json)
            self.assertNotIn("must not persist", json.dumps(summary, sort_keys=True))
            self.assertNotIn("sk-test-secret", json.dumps(summary, sort_keys=True))

            record = usage_record_from_summary(summary, usage_id="usage-fake-001")
            self.assertEqual(record["instanceId"], "worker-fake-001")
            self.assertEqual(record["workItemId"], "task-fake-001")
            self.assertEqual(record["sessionId"], "thread-fleet-001")
            self.assertEqual(record["tokens"], {
                "inputTokens": 120,
                "cachedInputTokens": 10,
                "outputTokens": 45,
                "totalTokens": 165,
            })
            self.assertNotIn("quota", record)
            self.assertEqual(record["source"], "agentmetrics")
            # The fake has token usage but no provider invoice. The derived
            # API-equivalent cost is therefore an estimate, never a metered
            # actual cost.
            self.assertEqual(record["estimateOrActual"], "estimate")
        finally:
            shutil.rmtree(worktree, ignore_errors=True)
            shutil.rmtree(fake_dir, ignore_errors=True)

    def test_invalid_workpackage_returns_invalid_input(self):
        """Empty -WorkPackage must short-circuit before Codex is invoked."""
        worktree = self._make_worktree()
        fake_dir, fake_basename = _make_named_fake_codex_dir(0, "fake-codex-never")
        try:
            proc = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-File", str(RUNNER),
                    "-WorkPackage", "",
                    "-Worktree", str(worktree),
                    "-CodexCommand", fake_basename,
                ],
                capture_output=True,
                text=True,
                env={**os.environ, "PATH": str(fake_dir) + os.pathsep + os.environ.get("PATH", "")},
                timeout=30,
            )
            # PowerShell's Mandatory binding on [string] rejects empty with
            # exit 1; the runner's own validator returns 4. Either is
            # acceptable evidence that Codex was NOT invoked.
            self.assertIn(
                proc.returncode, (1, 4),
                msg=f"Expected exit 1 or 4; got {proc.returncode}\nSTDERR:\n{proc.stderr}",
            )
            self.assertNotIn("RUN_ID=", proc.stdout)
            self.assertNotIn("fake-codex-never", proc.stdout)
        finally:
            shutil.rmtree(worktree, ignore_errors=True)
            shutil.rmtree(fake_dir, ignore_errors=True)

    def test_missing_worktree_returns_invalid_input(self):
        worktree = self._make_worktree()
        fake_dir, fake_basename = _make_named_fake_codex_dir(0, "fake-codex-never")
        try:
            bogus = str(worktree / "does-not-exist-12345")
            proc = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-File", str(RUNNER),
                    "-WorkPackage", "WP-OK",
                    "-Worktree", bogus,
                    "-CodexCommand", fake_basename,
                ],
                capture_output=True,
                text=True,
                env={**os.environ, "PATH": str(fake_dir) + os.pathsep + os.environ.get("PATH", "")},
                timeout=30,
            )
            self.assertEqual(
                proc.returncode, 4,
                msg=f"Expected exit 4; got {proc.returncode}\nSTDERR:\n{proc.stderr}",
            )
            self.assertNotIn("RUN_ID=", proc.stdout)
            self.assertNotIn("fake-codex-never", proc.stdout)
        finally:
            shutil.rmtree(worktree, ignore_errors=True)
            shutil.rmtree(fake_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
