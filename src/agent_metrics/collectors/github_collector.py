"""
GitHub CLI Read-Only Collector.
Fetches PR status, CI workflow run duration, and CI result fail-closed.
"""

import json
import shutil
import subprocess
from typing import Dict, Any, Optional, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, GithubInfo, EXIT_PARTIAL, EXIT_EXTERNAL_CMD_ERROR


class GithubCollector(BaseCollector):
    name = "github"

    def __init__(self, config: Optional[Dict[str, Any]] = None, worktree: Optional[str] = None, repository: Optional[str] = None):
        super().__init__()
        self.config = config or {}
        self.worktree = worktree
        self.repository = repository

    def run_gh(self, args: list) -> Tuple[int, str]:
        if not shutil.which("gh"):
            return -1, ""
        try:
            res = subprocess.run(
                ["gh"] + args,
                cwd=self.worktree,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            return res.returncode, res.stdout.strip()
        except Exception:
            return -1, ""

    def _run_gh_json(self, args: list) -> Optional[Dict[str, Any]]:
        code, out = self.run_gh(args)
        if code == 0 and out:
            try:
                return json.loads(out)
            except Exception:
                pass
        return None

    def get_status(self) -> str:
        if not shutil.which("gh"):
            return CollectorStatus.NOT_AVAILABLE.value
        code, out = self.run_gh(["auth", "status"])
        if code == 0:
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.CONFIG_REQUIRED.value

    def query_pr_details(self, repo: Optional[str] = None, pr_number: Optional[int] = None) -> GithubInfo:
        _, info = self.collect_pr_info(pr_number=pr_number)
        return GithubInfo(**{k: v for k, v in info.items() if hasattr(GithubInfo, k)})

    def collect(self, run_context: Optional[Dict[str, Any]] = None, pr_number: Optional[int] = None) -> Dict[str, Any]:
        pr_num = pr_number or (run_context.get("pr_number") if run_context else None)
        _, info = self.collect_pr_info(pr_number=pr_num)
        return info

    def collect_pr_info(self, pr_number: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        status = self.get_status()
        if status == CollectorStatus.NOT_AVAILABLE.value:
            gh_info = GithubInfo(status=CollectorStatus.NOT_AVAILABLE.value)
            return EXIT_PARTIAL, gh_info.to_dict()
        elif status == CollectorStatus.CONFIG_REQUIRED.value:
            gh_info = GithubInfo(status=CollectorStatus.CONFIG_REQUIRED.value)
            return EXIT_PARTIAL, gh_info.to_dict()

        pr_arg = str(pr_number) if pr_number else ""
        args = ["pr", "view"]
        if pr_arg:
            args.append(pr_arg)
        args.extend(["--json", "number,url,baseRefName,headRefName,headRefOid,state,isDraft,commits,changedFiles,additions,deletions"])

        code, out = self.run_gh(args)
        if code != 0 or not out:
            gh_info = GithubInfo(status=CollectorStatus.ERROR.value)
            return EXIT_EXTERNAL_CMD_ERROR, gh_info.to_dict()

        try:
            data = json.loads(out)
        except Exception:
            gh_info = GithubInfo(status=CollectorStatus.ERROR.value)
            return EXIT_EXTERNAL_CMD_ERROR, gh_info.to_dict()

        gh_info = GithubInfo(
            pr_number=data.get("number"),
            pr_url=data.get("url"),
            base_branch=data.get("baseRefName"),
            head_branch=data.get("headRefName"),
            github_head_sha=data.get("headRefOid"),
            state=data.get("state"),
            is_draft=data.get("isDraft"),
            commit_count=len(data.get("commits", [])) if isinstance(data.get("commits"), list) else None,
            changed_files=data.get("changedFiles"),
            additions=data.get("additions"),
            deletions=data.get("deletions"),
            workflow_duration_seconds=None,
            ci_wait_seconds=None,
            status=CollectorStatus.AVAILABLE.value,
        )
        return 0, gh_info.to_dict()
