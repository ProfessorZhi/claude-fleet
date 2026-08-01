"""
Read-only Claude Code session metadata & usage collector.
"""

import json
import os
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from .base import BaseCollector
from ..models import CollectorStatus, UsageInfo, ModelConfidence
from ..correlation import SessionCorrelator


class ClaudeCodeCollector(BaseCollector):
    def __init__(self, custom_config_dirs: Optional[List[Path]] = None):
        self.custom_config_dirs = custom_config_dirs

    @property
    def name(self) -> str:
        return "claude_code"

    def get_known_config_dirs(self) -> List[Path]:
        if self.custom_config_dirs is not None:
            return self.custom_config_dirs

        dirs = []
        # Check CLAUDE_CONFIG_DIR env
        env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
        if env_dir:
            dirs.append(Path(env_dir))

        user_home = Path.home()
        dirs.append(user_home / ".claude")
        dirs.append(user_home / ".claude-deepseek")
        dirs.append(user_home / ".claude-minimax")

        return dirs

    def check_availability(self) -> str:
        config_dirs = self.get_known_config_dirs()
        existing = [d for d in config_dirs if d.exists() and d.is_dir()]
        if existing:
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def scan_sessions(self) -> List[Dict[str, Any]]:
        sessions = []
        config_dirs = self.get_known_config_dirs()

        for c_dir in config_dirs:
            if not c_dir.exists() or not c_dir.is_dir():
                continue

            projects_dir = c_dir / "projects"
            sessions_dir = c_dir / "sessions"
            history_dir = c_dir / "history"

            search_paths = []
            if projects_dir.exists():
                search_paths.extend(projects_dir.rglob("*.json"))
            if sessions_dir.exists():
                search_paths.extend(sessions_dir.rglob("*.json"))
            if history_dir.exists():
                search_paths.extend(history_dir.rglob("*.json"))

            for f_path in search_paths:
                if not f_path.is_file():
                    continue
                try:
                    with open(f_path, "r", encoding="utf-8", errors="ignore") as f:
                        data = json.load(f)

                    if isinstance(data, dict) and ("session_id" in data or "usage" in data or "metadata" in data or "stats" in data):
                        sess = self._extract_session_summary(data, f_path)
                        if sess:
                            sessions.append(sess)
                except Exception:
                    continue

        return sessions

    def _extract_session_summary(self, data: Dict[str, Any], file_path: Path) -> Optional[Dict[str, Any]]:
        # Structured extraction without message bodies
        session_id = data.get("session_id") or data.get("id") or file_path.stem
        worktree = data.get("worktree") or data.get("cwd") or data.get("project_path")
        work_package = data.get("work_package") or (data.get("metadata", {}).get("work_package") if isinstance(data.get("metadata"), dict) else None)

        started_at = data.get("started_at") or data.get("created_at") or data.get("start_time")
        finished_at = data.get("finished_at") or data.get("updated_at") or data.get("end_time")

        usage = data.get("usage") or data.get("stats") or {}
        if not isinstance(usage, dict):
            usage = {}

        input_tokens = usage.get("input_tokens") or usage.get("inputTokens")
        output_tokens = usage.get("output_tokens") or usage.get("outputTokens")
        reasoning_tokens = usage.get("reasoning_tokens") or usage.get("reasoningTokens")
        cache_read = usage.get("cache_read_tokens") or usage.get("cacheReadTokens") or usage.get("cache_read_input_tokens")
        cache_write = usage.get("cache_write_tokens") or usage.get("cacheWriteTokens") or usage.get("cache_creation_input_tokens")
        total_tokens = usage.get("total_tokens") or usage.get("totalTokens")

        if total_tokens is None and (input_tokens is not None or output_tokens is not None):
            total_tokens = (input_tokens or 0) + (output_tokens or 0)

        duration_ms = data.get("duration_ms") or usage.get("duration_ms")
        api_duration_ms = data.get("api_duration_ms") or usage.get("api_duration_ms")
        turn_count = data.get("turn_count") or usage.get("turn_count")

        models_info = data.get("models") or {}
        if not isinstance(models_info, dict):
            models_info = {}

        configured_model = data.get("configured_model") or models_info.get("configured")
        requested_model = data.get("requested_model") or models_info.get("requested")
        observed_model = data.get("observed_model") or models_info.get("observed")

        permission_mode = data.get("permission_mode") or data.get("permissionMode")

        return {
            "session_id": str(session_id),
            "worktree": str(worktree) if worktree else None,
            "work_package": str(work_package) if work_package else None,
            "started_at": str(started_at) if started_at else None,
            "finished_at": str(finished_at) if finished_at else None,
            "input_tokens": int(input_tokens) if input_tokens is not None else None,
            "output_tokens": int(output_tokens) if output_tokens is not None else None,
            "reasoning_tokens": int(reasoning_tokens) if reasoning_tokens is not None else None,
            "cache_read_tokens": int(cache_read) if cache_read is not None else None,
            "cache_write_tokens": int(cache_write) if cache_write is not None else None,
            "total_tokens": int(total_tokens) if total_tokens is not None else None,
            "duration_ms": duration_ms,
            "api_duration_ms": api_duration_ms,
            "turn_count": turn_count,
            "configured_model": configured_model,
            "requested_model": requested_model,
            "observed_model": observed_model,
            "permission_mode": permission_mode,
            "file_path": str(file_path),
        }

    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        target_session_id = run_context.get("session_id")
        worktree = run_context.get("worktree")
        work_package = run_context.get("work_package")
        started_at = run_context.get("started_at")
        finished_at = run_context.get("finished_at")

        sessions = self.scan_sessions()
        matched, confidence = SessionCorrelator.correlate_sessions(
            target_session_id=target_session_id,
            target_worktree=worktree,
            target_work_package=work_package,
            started_at_str=started_at or "",
            finished_at_str=finished_at,
            available_sessions=sessions,
        )

        if not matched:
            return {
                "usage": UsageInfo(
                    collection_status="NOT_AVAILABLE",
                    correlation_confidence=confidence,
                    source="claude_code",
                ).to_dict(),
                "agent_metadata": {},
            }

        usage_info = UsageInfo(
            input_tokens=matched.get("input_tokens"),
            output_tokens=matched.get("output_tokens"),
            reasoning_tokens=matched.get("reasoning_tokens"),
            cache_read_tokens=matched.get("cache_read_tokens"),
            cache_write_tokens=matched.get("cache_write_tokens"),
            total_tokens=matched.get("total_tokens"),
            collection_status="COMPLETE" if matched.get("total_tokens") is not None else "PARTIAL",
            source="claude_code_session",
            correlation_confidence=confidence,
        )

        agent_metadata = {
            "session_id": matched.get("session_id"),
            "configured_model": matched.get("configured_model"),
            "requested_model": matched.get("requested_model"),
            "observed_model": matched.get("observed_model"),
            "permission_mode": matched.get("permission_mode"),
            "duration_ms": matched.get("duration_ms"),
            "turn_count": matched.get("turn_count"),
        }

        return {
            "usage": usage_info.to_dict(),
            "agent_metadata": agent_metadata,
        }
