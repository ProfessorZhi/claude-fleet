"""
Git Read-Only Collector.
Captures initial and final branch, head SHA, clean/dirty state, round commit count, and diff stats.
"""

import os
import re
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, GitInfo


class GitCollector(BaseCollector):
    name = "git"

    def __init__(self, config: Optional[Dict[str, Any]] = None, worktree: Optional[str] = None):
        super().__init__()
        self.config = config or {}
        self.worktree = worktree or os.getcwd()

    def run_git(self, args: list) -> Tuple[int, str]:
        try:
            res = subprocess.run(
                ["git"] + args,
                cwd=self.worktree,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
            return res.returncode, res.stdout.strip()
        except Exception:
            return -1, ""

    def get_status(self) -> str:
        code, out = self.run_git(["rev-parse", "--is-inside-work-tree"])
        if code == 0 and out == "true":
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None, initial_git_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self.get_status() != CollectorStatus.AVAILABLE.value:
            return GitInfo().to_dict()

        init_info = initial_git_info or (run_context.get("git_initial") if run_context else None)

        code_b, branch = self.run_git(["branch", "--show-current"])
        code_h, head_sha = self.run_git(["rev-parse", "HEAD"])
        code_s, status_out = self.run_git(["status", "--porcelain"])

        lines = [l for l in status_out.splitlines() if l.strip()]
        is_clean = len(lines) == 0

        unstaged = sum(1 for l in lines if l.startswith(" ") or (len(l) > 1 and l[1] not in (" ", "?")))
        staged = sum(1 for l in lines if len(l) > 0 and l[0] not in (" ", "?"))
        untracked = sum(1 for l in lines if l.startswith("??"))

        # Overall repository commit count
        _, total_commits_str = self.run_git(["rev-list", "--count", "HEAD"])
        total_commits = int(total_commits_str) if total_commits_str.isdigit() else 0

        initial_sha = init_info.get("initial_head_sha") if init_info else None
        round_commit_count = None
        round_changed_files = None
        round_additions = None
        round_deletions = None

        if initial_sha and head_sha and initial_sha != head_sha:
            code_rc, rc_str = self.run_git(["rev-list", "--count", f"{initial_sha}..{head_sha}"])
            if code_rc == 0 and rc_str.isdigit():
                round_commit_count = int(rc_str)

            code_diff, diff_stat = self.run_git(["diff", "--shortstat", f"{initial_sha}..{head_sha}"])
            if code_diff == 0 and diff_stat:
                m_files = re.search(r"(\d+)\s+file", diff_stat)
                m_adds = re.search(r"(\d+)\s+insertion", diff_stat)
                m_dels = re.search(r"(\d+)\s+deletion", diff_stat)

                round_changed_files = int(m_files.group(1)) if m_files else 0
                round_additions = int(m_adds.group(1)) if m_adds else 0
                round_deletions = int(m_dels.group(1)) if m_dels else 0

        git_info = GitInfo(
            initial_branch=init_info.get("initial_branch") if init_info else branch,
            initial_head_sha=initial_sha or head_sha,
            initial_clean=init_info.get("initial_clean") if init_info else is_clean,
            final_branch=branch,
            final_head_sha=head_sha,
            final_clean=is_clean,
            commit_count=total_commits,
            round_commit_count=round_commit_count,
            round_changed_files=round_changed_files,
            round_additions=round_additions,
            round_deletions=round_deletions,
            unstaged_changes=unstaged,
            staged_changes=staged,
            untracked_files=untracked,
        )
        return git_info.to_dict()
