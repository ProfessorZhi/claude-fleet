"""
Read-only GitHub CLI collector.
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional
from .base import BaseCollector
from ..models import CollectorStatus, GithubInfo


class GithubCollector(BaseCollector):
    @property
    def name(self) -> str:
        return "github"

    def check_availability(self) -> str:
        if shutil.which("gh") is None:
            return CollectorStatus.NOT_AVAILABLE.value

        # Check if logged in
        try:
            res = subprocess.run(
                ["gh", "auth", "status"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
            )
            if res.returncode == 0:
                return CollectorStatus.AVAILABLE.value
            return CollectorStatus.CONFIG_REQUIRED.value
        except Exception:
            return CollectorStatus.NOT_AVAILABLE.value

    def _run_gh_json(self, args: list[str], cwd: Optional[Path] = None) -> Optional[Any]:
        if shutil.which("gh") is None:
            return None
        try:
            res = subprocess.run(
                ["gh"] + args,
                cwd=str(cwd) if cwd else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            if res.returncode == 0 and res.stdout.strip():
                return json.loads(res.stdout)
            return None
        except Exception:
            return None

    def query_pr_details(
        self, repository: Optional[str], pr_number: int, cwd: Optional[Path] = None
    ) -> GithubInfo:
        pr_arg = str(pr_number)
        args = [
            "pr",
            "view",
            pr_arg,
            "--json",
            "number,url,baseRefName,headRefName,headRefOid,state,isDraft,commits,changedFiles,additions,deletions",
        ]
        if repository:
            args.extend(["-R", repository])

        pr_data = self._run_gh_json(args, cwd=cwd)
        if not pr_data or not isinstance(pr_data, dict):
            return GithubInfo(pr_number=pr_number)

        # Query CI runs for head SHA
        head_sha = pr_data.get("headRefOid")
        ci_run_id = None
        ci_started_at = None
        ci_completed_at = None
        ci_duration = None
        ci_result = None

        if head_sha:
            run_args = [
                "run",
                "list",
                "--commit",
                head_sha,
                "--json",
                "databaseId,createdAt,updatedAt,status,conclusion",
            ]
            if repository:
                run_args.extend(["-R", repository])
            runs = self._run_gh_json(run_args, cwd=cwd)

            if runs and isinstance(runs, list) and len(runs) > 0:
                latest_run = runs[0]
                ci_run_id = str(latest_run.get("databaseId", ""))
                ci_started_at = latest_run.get("createdAt")
                ci_completed_at = latest_run.get("updatedAt")
                ci_result = latest_run.get("conclusion") or latest_run.get("status")

                if ci_started_at and ci_completed_at:
                    try:
                        from datetime import datetime
                        s_dt = datetime.fromisoformat(ci_started_at.replace("Z", "+00:00"))
                        c_dt = datetime.fromisoformat(ci_completed_at.replace("Z", "+00:00"))
                        ci_duration = max(0.0, (c_dt - s_dt).total_seconds())
                    except Exception:
                        pass

        commits_list = pr_data.get("commits", [])
        commit_count = len(commits_list) if isinstance(commits_list, list) else None

        return GithubInfo(
            pr_number=pr_data.get("number", pr_number),
            pr_url=pr_data.get("url"),
            base_branch=pr_data.get("baseRefName"),
            head_branch=pr_data.get("headRefName"),
            github_head_sha=head_sha,
            state=pr_data.get("state"),
            is_draft=pr_data.get("isDraft"),
            commit_count=commit_count,
            changed_files=pr_data.get("changedFiles"),
            additions=pr_data.get("additions"),
            deletions=pr_data.get("deletions"),
            ci_run_id=ci_run_id,
            ci_started_at=ci_started_at,
            ci_completed_at=ci_completed_at,
            ci_duration_seconds=ci_duration,
            ci_result=ci_result,
        )

    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        pr_number = run_context.get("pr_number")
        if not pr_number:
            return GithubInfo().to_dict()
        repo = run_context.get("repository")
        wt = Path(run_context.get("worktree", "")) if run_context.get("worktree") else None
        info = self.query_pr_details(repo, int(pr_number), cwd=wt)
        return info.to_dict()
