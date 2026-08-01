"""
Claude Code Read-Only Collector.
Discovers local Claude Code configuration directories (.claude, .claude-deepseek, .claude-minimax).
Stream-reads JSONL transcripts line-by-line without loading full content into memory.
Extracts usage, model, and timing without reading prompts or message text.
"""

import json
import os
from pathlib import Path
from typing import Dict, Any, List, Optional, Set, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, ModelConfidence


class ClaudeCodeCollector(BaseCollector):
    name = "claude_code"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    def discover_config_dirs(self) -> List[Tuple[str, Path]]:
        dirs = []
        home = Path.home()

        custom = os.environ.get("CLAUDE_CONFIG_DIR")
        if custom:
            dirs.append(("custom", Path(custom)))

        default_claude = home / ".claude"
        if default_claude.exists():
            dirs.append(("default", default_claude))

        deepseek_claude = home / ".claude-deepseek"
        if deepseek_claude.exists():
            dirs.append(("deepseek", deepseek_claude))

        minimax_claude = home / ".claude-minimax"
        if minimax_claude.exists():
            dirs.append(("minimax", minimax_claude))

        return dirs

    def get_status(self) -> str:
        dirs = self.discover_config_dirs()
        if dirs:
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def parse_transcript_line_by_line(self, jsonl_file: Path) -> Optional[Dict[str, Any]]:
        session_id = None
        message_usages: Dict[str, Dict[str, Any]] = {}
        observed_model = None
        start_time = None
        end_time = None
        turn_count = 0

        try:
            with open(jsonl_file, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue

                    if not session_id and data.get("sessionId"):
                        session_id = data.get("sessionId")

                    ts = data.get("timestamp") or data.get("created_at")
                    if ts:
                        if not start_time or ts < start_time:
                            start_time = ts
                        if not end_time or ts > end_time:
                            end_time = ts

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
        }

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        config_dirs = self.discover_config_dirs()
        if not config_dirs:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "config_dirs": [],
                "sessions": [],
            }

        sessions = []
        for name, dir_path in config_dirs:
            projects_dir = dir_path / "projects"
            if projects_dir.exists():
                for jsonl_file in projects_dir.rglob("*.jsonl"):
                    res = self.parse_transcript_line_by_line(jsonl_file)
                    if res:
                        res["config_dir_name"] = name
                        sessions.append(res)

        if not sessions:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "config_dirs": [str(d[1]) for d in config_dirs],
                "sessions": [],
            }

        return {
            "status": CollectorStatus.AVAILABLE.value,
            "config_dirs": [str(d[1]) for d in config_dirs],
            "sessions": sessions,
        }
