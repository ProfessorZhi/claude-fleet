"""
Claude Code Read-Only Collector.
Discovers local Claude Code configuration directories (.claude, .claude-deepseek, .claude-minimax).
Stream-reads JSONL transcripts line-by-line without loading full content into memory.
Extracts usage, model, and timing without reading prompts or message text.
"""

import json
import hashlib
import os
import re
from pathlib import Path
from typing import Dict, Any, List, Optional, Set, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, CorrelationConfidence


RE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def is_valid_session_id(session_id: str) -> bool:
    if not isinstance(session_id, str):
        return False
    if session_id in (".", ".."):
        return False
    if not RE_SESSION_ID.match(session_id):
        return False
    if ":" in session_id or "\\" in session_id or "/" in session_id or " " in session_id:
        return False
    if "--Users-" in session_id or "-home-" in session_id:
        return False
    if len(session_id) >= 3 and session_id[0].isalpha() and session_id[1:3] == "--":
        return False
    user = os.environ.get("USERNAME") or os.environ.get("USER")
    if user and len(user) > 2 and user.lower() in session_id.lower():
        return False
    return True


def _message_id_hash(message_id: str) -> str:
    return hashlib.sha256(message_id.encode("utf-8", errors="ignore")).hexdigest()


def _safe_int(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(0, value)
    return 0


class ClaudeCodeCollector(BaseCollector):
    name = "claude_code"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    def discover_config_dirs(self) -> List[Tuple[str, Path]]:
        home = Path.home()
        config_dirs = []
        mapping = {
            "default": home / ".claude",
            "deepseek": home / ".claude-deepseek",
            "minimax": home / ".claude-minimax",
        }

        custom_env = os.environ.get("CLAUDE_CONFIG_DIR")
        if custom_env:
            config_dirs.append(("custom", Path(custom_env)))
        elif self.config.get("claude_config_dir"):
            config_dirs.append(("custom", Path(self.config["claude_config_dir"])))

        for name, dir_path in mapping.items():
            if dir_path.exists():
                config_dirs.append((name, dir_path))

        deduped: List[Tuple[str, Path]] = []
        seen_paths: Set[str] = set()
        for name, dir_path in config_dirs:
            try:
                key = str(dir_path.expanduser().resolve()).casefold()
            except Exception:
                key = str(dir_path.expanduser().absolute()).casefold()
            if key in seen_paths:
                continue
            seen_paths.add(key)
            deduped.append((name, dir_path))

        return deduped

    def get_status(self) -> str:
        dirs = self.discover_config_dirs()
        if dirs:
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def create_session_baseline(self) -> List[Dict[str, Any]]:
        baseline = []
        config_dirs = self.discover_config_dirs()
        for name, dir_path in config_dirs:
            projects_dir = dir_path / "projects"
            if projects_dir.exists():
                for jsonl_file in projects_dir.rglob("*.jsonl"):
                    try:
                        session_id = jsonl_file.stem
                        if not is_valid_session_id(session_id):
                            continue
                        stat = jsonl_file.stat()
                        baseline.append({
                            "config_dir_name": name,
                            "session_id": session_id,
                            "file_size": stat.st_size,
                            "last_modified": stat.st_mtime,
                        })
                    except Exception:
                        pass
        return baseline

    def find_session_files(
        self,
        session_id: str,
        config_dir_name: Optional[str] = None,
    ) -> List[Tuple[str, Path]]:
        if not is_valid_session_id(session_id):
            return []

        matches = []
        for name, dir_path in self.discover_config_dirs():
            if config_dir_name and name != config_dir_name:
                continue
            projects_dir = dir_path / "projects"
            if not projects_dir.exists():
                continue
            for jsonl_file in projects_dir.rglob(f"{session_id}.jsonl"):
                if jsonl_file.stem == session_id:
                    matches.append((name, jsonl_file))
        return matches

    def _read_cursor_metadata(self, jsonl_file: Path, offset: int) -> Dict[str, Any]:
        message_hashes: Set[str] = set()
        last_ts = None
        safe_offset = max(0, offset)
        try:
            with open(jsonl_file, "rb") as f:
                raw = f.read(safe_offset)
            for line in raw.decode("utf-8", errors="ignore").splitlines():
                stripped = line.strip()
                if not stripped.startswith("{"):
                    continue
                try:
                    data = json.loads(stripped)
                except Exception:
                    continue
                ts = data.get("timestamp") or data.get("created_at")
                if ts and (not last_ts or ts > last_ts):
                    last_ts = ts
                msg = data.get("message")
                if isinstance(msg, dict):
                    msg_id = msg.get("id")
                    if isinstance(msg_id, str) and msg_id:
                        message_hashes.add(_message_id_hash(msg_id))
        except Exception:
            pass
        return {
            "jsonl_size_before": safe_offset,
            "last_event_timestamp_before": last_ts,
            "known_message_id_hashes_before": sorted(message_hashes),
        }

    def create_session_cursor(
        self,
        session_id: str,
        baseline: Optional[List[Dict[str, Any]]] = None,
        config_dir_name: Optional[str] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        if not is_valid_session_id(session_id):
            return None, CollectorStatus.NOT_AVAILABLE.value

        files = self.find_session_files(session_id, config_dir_name=config_dir_name)
        if len(files) != 1:
            return None, CorrelationConfidence.AMBIGUOUS.value if len(files) > 1 else CollectorStatus.NOT_AVAILABLE.value

        matched_config_name, jsonl_file = files[0]
        offset = 0
        found_baseline_entry = False
        for entry in baseline or []:
            if entry.get("session_id") == session_id and entry.get("config_dir_name") == matched_config_name:
                offset = _safe_int(entry.get("file_size"))
                found_baseline_entry = True
                break

        cursor = (
            self._read_cursor_metadata(jsonl_file, offset)
            if found_baseline_entry and offset > 0
            else {
                "jsonl_size_before": 0,
                "last_event_timestamp_before": None,
                "known_message_id_hashes_before": [],
            }
        )
        cursor["config_dir_name"] = matched_config_name
        cursor["session_id"] = session_id
        return cursor, CollectorStatus.AVAILABLE.value

    def parse_transcript_line_by_line(
        self,
        jsonl_file: Path,
        started_at: Optional[str] = None,
        finished_at: Optional[str] = None,
        cursor_before: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        session_id = None
        message_usages: Dict[str, Dict[str, Any]] = {}
        segment_message_hashes: Set[str] = set()
        observed_model = None
        start_time = None
        end_time = None
        turn_count = 0
        worktree_in_file = None
        work_package_in_file = None
        offset_before = _safe_int((cursor_before or {}).get("jsonl_size_before"))
        known_before = set((cursor_before or {}).get("known_message_id_hashes_before") or [])
        file_size_after = 0

        try:
            file_size_after = jsonl_file.stat().st_size
            if offset_before > file_size_after:
                return {
                    "session_id": jsonl_file.stem,
                    "observed_model": None,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "reasoning_tokens": 0,
                    "total_tokens": 0,
                    "start_time": None,
                    "end_time": None,
                    "turn_count": 0,
                    "file_path": str(jsonl_file),
                    "worktree": None,
                    "work_package": None,
                    "session_cursor_after": {
                        "config_dir_name": (cursor_before or {}).get("config_dir_name"),
                        "session_id": jsonl_file.stem,
                        "jsonl_size_after": file_size_after,
                        "last_event_timestamp_after": None,
                        "known_message_id_hashes_after": sorted(known_before),
                    },
                }
            with open(jsonl_file, "r", encoding="utf-8", errors="ignore") as f:
                if offset_before and offset_before <= file_size_after:
                    f.seek(offset_before)
                for line in f:
                    line = line.strip().lstrip("\ufeff")
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue

                    if not session_id and data.get("sessionId"):
                        session_id = data.get("sessionId")

                    ts = data.get("timestamp") or data.get("created_at")
                    # Time window filtering
                    if ts:
                        if started_at and ts < started_at:
                            continue
                        if finished_at and ts > finished_at:
                            continue
                        if not start_time or ts < start_time:
                            start_time = ts
                        if not end_time or ts > end_time:
                            end_time = ts

                    cwd = data.get("cwd") or data.get("worktree")
                    if cwd and not worktree_in_file:
                        worktree_in_file = str(cwd)

                    wp = data.get("work_package") or data.get("workPackage")
                    if wp and not work_package_in_file:
                        work_package_in_file = str(wp)

                    evt_type = data.get("type")
                    if evt_type == "assistant":
                        turn_count += 1
                        msg = data.get("message")
                        if isinstance(msg, dict):
                            msg_id = msg.get("id")
                            model = msg.get("model")
                            if model:
                                observed_model = model

                            usage = msg.get("usage")
                            if isinstance(usage, dict) and msg_id:
                                msg_hash = _message_id_hash(str(msg_id))
                                if msg_hash in known_before:
                                    continue
                                segment_message_hashes.add(msg_hash)
                                message_usages[msg_id] = usage
                    elif evt_type == "user":
                        turn_count += 1
        except Exception:
            return None

        if not message_usages and not session_id:
            return None

        total_input = 0
        total_output = 0
        total_cache_read = 0
        total_cache_write = 0
        total_reasoning = 0

        for usage in message_usages.values():
            total_input += usage.get("input_tokens", 0) or 0
            total_output += usage.get("output_tokens", 0) or 0
            total_cache_read += usage.get("cache_read_input_tokens", 0) or usage.get("cache_read_tokens", 0) or 0
            total_cache_write += usage.get("cache_creation_input_tokens", 0) or usage.get("cache_write_tokens", 0) or 0
            total_reasoning += usage.get("reasoning_tokens", 0) or 0

        total_tokens = total_input + total_output

        return {
            "session_id": session_id or jsonl_file.stem,
            "observed_model": observed_model,
            "input_tokens": total_input,
            "output_tokens": total_output,
            "cache_read_tokens": total_cache_read,
            "cache_write_tokens": total_cache_write,
            "reasoning_tokens": total_reasoning,
            "total_tokens": total_tokens,
            "start_time": start_time,
            "end_time": end_time,
            "turn_count": turn_count,
            "file_path": str(jsonl_file),
            "worktree": worktree_in_file,
            "work_package": work_package_in_file,
            "session_cursor_after": {
                "config_dir_name": (cursor_before or {}).get("config_dir_name"),
                "session_id": session_id or jsonl_file.stem,
                "jsonl_size_after": file_size_after,
                "last_event_timestamp_after": end_time,
                "known_message_id_hashes_after": sorted(known_before | segment_message_hashes),
            },
        }

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        config_dirs = self.discover_config_dirs()
        if not config_dirs:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "config_dirs": [],
                "sessions": [],
            }

        started_at = run_context.get("started_at") if run_context else None
        finished_at = run_context.get("finished_at") if run_context else None
        req_session_id = run_context.get("session_id") if run_context else None
        req_session_id = (run_context.get("agent_session_id") if run_context else None) or req_session_id
        req_worktree = run_context.get("worktree") if run_context else None
        req_wp = run_context.get("work_package") if run_context else None
        req_cursor = run_context.get("session_cursor_before") if run_context else None
        req_config_dir_name = req_cursor.get("config_dir_name") if isinstance(req_cursor, dict) else None
        require_exact_session = bool(run_context.get("require_exact_session")) if run_context else False

        sessions = []
        for name, dir_path in config_dirs:
            if req_config_dir_name and name != req_config_dir_name:
                continue
            projects_dir = dir_path / "projects"
            if projects_dir.exists():
                for jsonl_file in projects_dir.rglob("*.jsonl"):
                    if req_session_id and jsonl_file.stem != req_session_id:
                        continue
                    res = self.parse_transcript_line_by_line(
                        jsonl_file,
                        started_at=started_at,
                        finished_at=finished_at,
                        cursor_before=req_cursor if jsonl_file.stem == req_session_id else None,
                    )
                    if res:
                        res["config_dir_name"] = name
                        sessions.append(res)

        if not sessions:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "config_dirs": [d[0] for d in config_dirs],
                "sessions": [],
            }

        # Correlation matching priorities
        matched_session = None
        confidence = CorrelationConfidence.NOT_AVAILABLE.value

        # Priority 1: Explicit Session ID match
        if req_session_id:
            sid_matches = [s for s in sessions if s.get("session_id") == req_session_id]
            if len(sid_matches) == 1:
                matched_session = sid_matches[0]
                confidence = (
                    CorrelationConfidence.EXACT_SESSION_AND_CURSOR.value
                    if isinstance(req_cursor, dict)
                    else CorrelationConfidence.EXACT_SESSION.value
                )
            elif len(sid_matches) > 1:
                confidence = CorrelationConfidence.AMBIGUOUS.value
            else:
                confidence = CorrelationConfidence.NOT_AVAILABLE.value

        if require_exact_session and not matched_session:
            return {
                "status": CollectorStatus.AVAILABLE.value,
                "config_dirs": [d[0] for d in config_dirs],
                "sessions": sessions,
                "matched_session": None,
                "correlation_confidence": confidence,
            }

        # Priority 2: Worktree match
        if not matched_session and confidence != CorrelationConfidence.AMBIGUOUS.value and req_worktree:
            wt_matches = [s for s in sessions if s.get("worktree") and str(s.get("worktree")).lower() == str(req_worktree).lower()]
            if len(wt_matches) == 1:
                matched_session = wt_matches[0]
                confidence = CorrelationConfidence.EXACT_WORKTREE.value
            elif len(wt_matches) > 1:
                confidence = CorrelationConfidence.AMBIGUOUS.value

        # Priority 3: Work package match
        if not matched_session and confidence != CorrelationConfidence.AMBIGUOUS.value and req_wp:
            wp_matches = [s for s in sessions if s.get("work_package") and str(s.get("work_package")).lower() == str(req_wp).lower()]
            if len(wp_matches) == 1:
                matched_session = wp_matches[0]
                confidence = CorrelationConfidence.EXACT_WORK_PACKAGE.value
            elif len(wp_matches) > 1:
                confidence = CorrelationConfidence.AMBIGUOUS.value

        # Priority 4: Unique time window match
        if not matched_session and confidence != CorrelationConfidence.AMBIGUOUS.value:
            if len(sessions) == 1:
                matched_session = sessions[0]
                confidence = CorrelationConfidence.TIME_WINDOW_MATCH.value
            elif len(sessions) > 1:
                confidence = CorrelationConfidence.AMBIGUOUS.value

        return {
            "status": CollectorStatus.AVAILABLE.value,
            "config_dirs": [d[0] for d in config_dirs],
            "sessions": sessions,
            "matched_session": matched_session,
            "correlation_confidence": confidence,
        }
