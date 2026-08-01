"""
Session and event correlation engine.
"""

from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple, Optional
from .models import CorrelationConfidence


class SessionCorrelator:
    @staticmethod
    def parse_iso_dt(dt_str: str) -> Optional[datetime]:
        if not dt_str:
            return None
        try:
            # Handle Z suffix
            clean_str = dt_str.replace("Z", "+00:00")
            return datetime.fromisoformat(clean_str)
        except Exception:
            return None

    @classmethod
    def correlate_sessions(
        self,
        target_session_id: Optional[str],
        target_worktree: Optional[str],
        target_work_package: Optional[str],
        started_at_str: str,
        finished_at_str: Optional[str],
        available_sessions: List[Dict[str, Any]],
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        if not available_sessions:
            return None, CorrelationConfidence.NOT_AVAILABLE.value

        # 1. Exact Session ID
        if target_session_id:
            matches = [s for s in available_sessions if s.get("session_id") == target_session_id]
            if len(matches) == 1:
                return matches[0], CorrelationConfidence.EXACT_SESSION.value
            elif len(matches) > 1:
                return None, CorrelationConfidence.AMBIGUOUS.value

        # 2. Exact Worktree
        if target_worktree:
            norm_wt = target_worktree.lower().rstrip(r"\/")
            matches = [
                s
                for s in available_sessions
                if s.get("worktree") and str(s.get("worktree")).lower().rstrip(r"\/") == norm_wt
            ]
            if len(matches) == 1:
                return matches[0], CorrelationConfidence.EXACT_WORKTREE.value
            elif len(matches) > 1:
                return None, CorrelationConfidence.AMBIGUOUS.value

        # 3. Exact Work Package
        if target_work_package:
            norm_wp = target_work_package.lower().strip()
            matches = [
                s
                for s in available_sessions
                if s.get("work_package") and str(s.get("work_package")).lower().strip() == norm_wp
            ]
            if len(matches) == 1:
                return matches[0], CorrelationConfidence.EXACT_WORK_PACKAGE.value
            elif len(matches) > 1:
                return None, CorrelationConfidence.AMBIGUOUS.value

        # 4. Time Window Match
        start_dt = self.parse_iso_dt(started_at_str)
        finish_dt = self.parse_iso_dt(finished_at_str) if finished_at_str else datetime.now(timezone.utc)

        if start_dt:
            matches = []
            for s in available_sessions:
                s_start = self.parse_iso_dt(s.get("started_at", ""))
                s_finish = self.parse_iso_dt(s.get("finished_at", "")) or datetime.now(timezone.utc)
                if s_start and s_finish:
                    # Check overlap
                    if max(start_dt, s_start) <= min(finish_dt, s_finish):
                        matches.append(s)

            if len(matches) == 1:
                return matches[0], CorrelationConfidence.TIME_WINDOW_MATCH.value
            elif len(matches) > 1:
                return None, CorrelationConfidence.AMBIGUOUS.value

        return None, CorrelationConfidence.NOT_AVAILABLE.value
