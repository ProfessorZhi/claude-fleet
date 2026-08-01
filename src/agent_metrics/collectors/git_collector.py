"""
Read-only Git collector.
"""

import subprocess
import shutil
from pathlib import Path
from typing import Dict, Any, Optional
from .base import BaseCollector
from ..models import CollectorStatus, GitInfo


class GitCollector(BaseCollector):
    @property
    def name(self) -> str:
        return "git"

    def check_availability(self) -> str:
        if shutil.which("git") is None:
            return CollectorStatus.NOT_AVAILABLE.value
        return CollectorStatus.AVAILABLE.value

    def _run_git_cmd(self, worktree: Path, args: list[str]) -> Optional[str]:
        if shutil.which("git") is None:
            return None
        try:
            res = subprocess.run(
                ["git"] + args,
                cwd=str(worktree),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
            if res.returncode == 0:
                return res.stdout.strip()
            return None
        except Exception:
            return None

    def get_git_snapshot(self, worktree_path: str) -> GitInfo:
        if not worktree_path:
            return GitInfo()

        wt = Path(worktree_path)
        if not wt.exists() or not wt.is_dir():
            return GitInfo()

        branch = self._run_git_cmd(wt, ["branch", "--show-current"])
        head_sha = self._run_git_cmd(wt, ["rev-parse", "HEAD"])
        status_out = self._run_git_cmd(wt, ["status", "--porcelain"])

        is_clean = None
        if status_out is not None:
            is_clean = (len(status_out.strip()) == 0)

        commit_count_str = self._run_git_cmd(wt, ["rev-list", "--count", "HEAD"])
        commit_count = None
        if commit_count_str and commit_count_str.isdigit():
            commit_count = int(commit_count_str)

        diff_stat = self._run_git_cmd(wt, ["diff", "--shortstat"])
        files_changed = None
        additions = None
        deletions = None

        if diff_stat:
            # e.g., "3 files changed, 10 insertions(+), 5 deletions(-)"
            import re
            m_files = re.search(r"(\d+)\s+file", diff_stat)
            m_ins = re.search(r"(\d+)\s+insertion", diff_stat)
            m_del = re.search(r"(\d+)\s+deletion", diff_stat)

            if m_files:
                files_changed = int(m_files.group(1))
            if m_ins:
                additions = int(m_ins.group(1))
            if m_del:
                deletions = int(m_del.group(1))

        return GitInfo(
            initial_branch=branch,
            initial_head_sha=head_sha,
            initial_clean=is_clean,
            final_branch=branch,
            final_head_sha=head_sha,
            final_clean=is_clean,
            commit_count=commit_count,
            files_changed=files_changed,
            additions=additions,
            deletions=deletions,
        )

    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        wt_path = run_context.get("worktree", "")
        info = self.get_git_snapshot(wt_path)
        return info.to_dict()
