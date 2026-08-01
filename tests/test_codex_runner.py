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

    def _run_runner(self, worktree, fake_dir, fake_basename, work_package):
        env = os.environ.copy()
        env["PATH"] = str(fake_dir) + os.pathsep + env.get("PATH", "")
        # Use a unique work-package per run so the .local/runs tree stays
        # observable per-test and we can clean it up after each test.
        proc = subprocess.run(
            [
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", str(RUNNER),
                "-WorkPackage", work_package,
                "-Worktree", str(worktree),
                "-CodexCommand", fake_basename,
                "fake-arg-1",
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        return proc

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
