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
            cmd = ["gh"] + args
            if self.repository and "--repo" not in args:
                cmd.extend(["--repo", self.repository])

            res = subprocess.run(
                cmd,
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
        target_repo = repo or self.repository
        if target_repo:
            self.repository = target_repo
        _, info = self.collect_pr_info(pr_number=pr_number)
        if pr_number and not info.get("pr_number"):
            info["pr_number"] = pr_number
        return GithubInfo(**{k: v for k, v in info.items() if hasattr(GithubInfo, k)})

    def collect(self, run_context: Optional[Dict[str, Any]] = None, pr_number: Optional[int] = None) -> Dict[str, Any]:
        pr_num = pr_number or (run_context.get("pr_number") if run_context else None)
        _, info = self.collect_pr_info(pr_number=pr_num)
        return info

    def collect_pr_info(self, pr_number: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        pr_arg = str(pr_number) if pr_number else ""
        args = ["pr", "view"]
        if pr_arg:
            args.append(pr_arg)
        args.extend(["--json", "number,url,baseRefName,headRefName,headRefOid,state,isDraft,commits,changedFiles,additions,deletions"])

        data = self._run_gh_json(args)
        if not data:
            status = self.get_status()
            if status == CollectorStatus.NOT_AVAILABLE.value:
                gh_info = GithubInfo(status=CollectorStatus.NOT_AVAILABLE.value)
                return EXIT_PARTIAL, gh_info.to_dict()
            elif status == CollectorStatus.CONFIG_REQUIRED.value:
                gh_info = GithubInfo(status=CollectorStatus.CONFIG_REQUIRED.value)
                return EXIT_PARTIAL, gh_info.to_dict()
            gh_info = GithubInfo(status=CollectorStatus.ERROR.value)
            return EXIT_EXTERNAL_CMD_ERROR, gh_info.to_dict()

        # Try to fetch CI runs for the exact PR head SHA. Do not use the
        # repository's latest workflow run; that can belong to a different PR.
        runs = self._run_gh_json(["run", "list", "--limit", "20", "--json", "databaseId,createdAt,updatedAt,runStartedAt,status,conclusion,headSha,url"])
        ci_run_id = None
        ci_result = None
        ci_queue_seconds = None
        ci_run_seconds = None
        ci_queued_at = None
        ci_started_at = None
        ci_completed_at = None

        pr_head_sha = data.get("headRefOid")
        matching_runs = []
        if isinstance(runs, list):
            for r in runs:
                if not isinstance(r, dict):
                    continue
                if "headSha" not in r and len(runs) == 1:
                    matching_runs.append(r)
                elif not pr_head_sha or r.get("headSha") == pr_head_sha:
                    matching_runs.append(r)

        if matching_runs:
            r = matching_runs[0]
            ci_run_id = str(r.get("databaseId")) if r.get("databaseId") else None
            ci_result = r.get("conclusion") or r.get("status")
            c_at = r.get("createdAt")
            s_at = r.get("runStartedAt") or r.get("startedAt")
            u_at = r.get("updatedAt")
            ci_queued_at = c_at
            ci_started_at = s_at
            ci_completed_at = u_at
            if c_at and s_at:
                try:
                    import datetime
                    t1 = datetime.datetime.fromisoformat(c_at.replace("Z", "+00:00"))
                    t2 = datetime.datetime.fromisoformat(s_at.replace("Z", "+00:00"))
                    ci_queue_seconds = max(0.0, (t2 - t1).total_seconds())
                except Exception:
                    pass
            if s_at and u_at:
                try:
                    import datetime
                    t1 = datetime.datetime.fromisoformat(s_at.replace("Z", "+00:00"))
                    t2 = datetime.datetime.fromisoformat(u_at.replace("Z", "+00:00"))
                    ci_run_seconds = max(0.0, (t2 - t1).total_seconds())
                except Exception:
                    pass
            elif c_at and u_at:
                try:
                    import datetime
                    t1 = datetime.datetime.fromisoformat(c_at.replace("Z", "+00:00"))
                    t2 = datetime.datetime.fromisoformat(u_at.replace("Z", "+00:00"))
                    ci_run_seconds = max(0.0, (t2 - t1).total_seconds())
                    ci_queue_seconds = 0.0
                    ci_started_at = c_at
                except Exception:
                    pass

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
            ci_run_id=ci_run_id,
            ci_result=ci_result,
            ci_duration_seconds=ci_run_seconds,
            workflow_duration_seconds=(ci_queue_seconds + ci_run_seconds) if ci_queue_seconds is not None and ci_run_seconds is not None else None,
            ci_wait_seconds=None,
            ci_queued_at=ci_queued_at,
            ci_started_at=ci_started_at,
            ci_completed_at=ci_completed_at,
            ci_queue_seconds=ci_queue_seconds,
            ci_run_seconds=ci_run_seconds,
            status=CollectorStatus.AVAILABLE.value,
        )
        return 0, gh_info.to_dict()
