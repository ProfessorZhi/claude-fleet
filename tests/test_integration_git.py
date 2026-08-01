"""
Integration tests for temporary Git repositories (Phase 3.2).
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_metrics.collectors.git_collector import GitCollector


class TestIntegrationGit(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.git_collector = GitCollector()

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _init_git_repo(self, repo_path: Path):
        repo_path.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init"], cwd=str(repo_path), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["git", "config", "user.name", "TestUser"], cwd=str(repo_path), check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(repo_path), check=True)

    def test_git_repo_clean_and_dirty(self):
        repo = Path(self.temp_dir, "my_repo")
        self._init_git_repo(repo)

        # Create file and commit
        f1 = repo / "file1.txt"
        f1.write_text("Hello Git", encoding="utf-8")
        subprocess.run(["git", "add", "file1.txt"], cwd=str(repo), check=True)
        subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=str(repo), check=True)

        snapshot1 = self.git_collector.get_git_snapshot(str(repo))
        self.assertIsNotNone(snapshot1.initial_head_sha)
        self.assertTrue(snapshot1.initial_clean)
        self.assertEqual(snapshot1.commit_count, 1)

        # Make dirty
        f2 = repo / "file2.txt"
        f2.write_text("Dirty file", encoding="utf-8")
        snapshot2 = self.git_collector.get_git_snapshot(str(repo))
        self.assertFalse(snapshot2.initial_clean)

    def test_git_path_with_spaces_and_unicode(self):
        repo = Path(self.temp_dir, "测试 路径 with space")
        self._init_git_repo(repo)

        f1 = repo / "测试文件.txt"
        f1.write_text("Unicode content", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=str(repo), check=True)
        subprocess.run(["git", "commit", "-m", "Unicode commit"], cwd=str(repo), check=True)

        snapshot = self.git_collector.get_git_snapshot(str(repo))
        self.assertIsNotNone(snapshot.initial_head_sha)
        self.assertEqual(snapshot.commit_count, 1)

    def test_non_git_directory(self):
        non_git = Path(self.temp_dir, "plain_folder")
        non_git.mkdir(parents=True, exist_ok=True)

        snapshot = self.git_collector.get_git_snapshot(str(non_git))
        self.assertIsNone(snapshot.initial_head_sha)
        self.assertIsNone(snapshot.initial_clean)


if __name__ == "__main__":
    unittest.main()
