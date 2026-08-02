"""
Codex exec --json read-only usage collector.

Consumes a caller-provided JSON/JSONL stream produced by `codex exec --json`.
Only usage bucket metadata and timestamps are retained. Prompt, response,
tool input/output, and code-like payload fields are ignored.
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from typing import Any, Dict, Optional

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, CorrelationConfidence, UsageInfo


def _safe_int(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float) and value >= 0 and value.is_integer():
        return int(value)
    return 0


def _first_int(data: Dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in data:
            return _safe_int(data.get(key))
    return 0


def _extract_usage(obj: Dict[str, Any]) -> Optional[Dict[str, int]]:
    candidates = []
    for key in ("usage", "token_usage", "tokens"):
        value = obj.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    candidates.append(obj)

    for usage in candidates:
        input_tokens = _first_int(usage, "input_tokens", "prompt_tokens")
        cached_input = _first_int(
            usage,
            "cached_input_tokens",
            "cache_read_input_tokens",
            "cache_read_tokens",
        )
        cache_write = _first_int(
            usage,
            "cache_write_input_tokens",
            "cache_creation_input_tokens",
            "cache_write_tokens",
        )
        output_tokens = _first_int(usage, "output_tokens", "completion_tokens")
        reasoning_tokens = _first_int(
            usage,
            "reasoning_output_tokens",
            "output_reasoning_tokens",
            "reasoning_tokens",
        )
        if any((input_tokens, cached_input, cache_write, output_tokens, reasoning_tokens)):
            return {
                "input_tokens": input_tokens,
                "cache_read_tokens": cached_input,
                "cache_write_tokens": cache_write,
                "output_tokens": output_tokens,
                "reasoning_tokens": reasoning_tokens,
            }
    return None


def _thread_id(obj: Dict[str, Any]) -> str:
    for key in ("thread_id", "threadId", "conversation_id"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    thread = obj.get("thread")
    if isinstance(thread, dict):
        value = thread.get("id") or thread.get("thread_id") or thread.get("threadId")
        if isinstance(value, str) and value:
            return value
    return "unknown-thread"


def _turn_ordinal(obj: Dict[str, Any]) -> Optional[str]:
    for key in ("turn_ordinal", "turn_index", "turnIndex", "turn_number", "turnNumber"):
        value = obj.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
        if isinstance(value, str) and value:
            return value
    turn = obj.get("turn")
    if isinstance(turn, dict):
        for key in ("ordinal", "index", "number"):
            value = turn.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                return str(value)
            if isinstance(value, str) and value:
                return value
    return None


def _event_id(obj: Dict[str, Any]) -> Optional[str]:
    for key in ("event_id", "eventId", "id"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _timestamp(obj: Dict[str, Any]) -> Optional[str]:
    for key in ("timestamp", "created_at", "createdAt", "time", "observed_at"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _event_type(obj: Dict[str, Any]) -> Optional[str]:
    for key in ("type", "event", "event_type"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _parse_iso(value: str) -> Optional[datetime.datetime]:
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _observed_model(obj: Dict[str, Any]) -> Optional[str]:
    for key in ("model", "model_name", "modelName"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    payload = obj.get("payload")
    if isinstance(payload, dict):
        return _observed_model(payload)
    return None


class CodexExecJsonCollector(BaseCollector):
    name = "codex_exec_json"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    def get_status(self) -> str:
        path = self.config.get("json_log_path")
        if path and Path(path).exists():
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        path = (
            (run_context or {}).get("codex_json_log")
            or self.config.get("json_log_path")
        )
        if not path:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "usage": UsageInfo(collection_status="NOT_AVAILABLE").to_dict(),
            }

        p = Path(path)
        if not p.is_file() or p.stat().st_size > 16 * 1024 * 1024:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "usage": UsageInfo(collection_status="NOT_AVAILABLE").to_dict(),
            }

        turns: Dict[str, Dict[str, int]] = {}
        seen_events = set()
        observed_threads = set()
        usage_threads = set()
        synthetic_idx = 0
        observed_model = None
        first_ts = None
        last_ts = None
        malformed = 0

        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    stripped = line.strip()
                    if not stripped or not stripped.startswith("{"):
                        continue
                    try:
                        obj = json.loads(stripped)
                    except json.JSONDecodeError:
                        malformed += 1
                        continue
                    if not isinstance(obj, dict):
                        continue

                    model = _observed_model(obj)
                    if model:
                        observed_model = model

                    tid = _thread_id(obj)
                    if tid != "unknown-thread":
                        observed_threads.add(tid)

                    ts = _timestamp(obj)
                    if ts:
                        parsed = _parse_iso(ts)
                        if parsed:
                            first_ts = parsed if first_ts is None or parsed < first_ts else first_ts
                            last_ts = parsed if last_ts is None or parsed > last_ts else last_ts

                    event_id = _event_id(obj)
                    if event_id and event_id in seen_events:
                        continue
                    if event_id:
                        seen_events.add(event_id)

                    usage = _extract_usage(obj)
                    if not usage:
                        continue
                    if tid != "unknown-thread":
                        usage_threads.add(tid)
                    ordinal = _turn_ordinal(obj)
                    if ordinal is None:
                        synthetic_idx += 1
                        ordinal = f"event-{synthetic_idx}"
                    turns[f"{tid}:{ordinal}"] = usage
        except OSError:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "usage": UsageInfo(collection_status="NOT_AVAILABLE").to_dict(),
            }

        totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
        for usage in turns.values():
            for key in totals:
                totals[key] += usage.get(key, 0)

        total_tokens = totals["input_tokens"] + totals["output_tokens"]
        has_usage = any(totals.values())
        requested_thread = (run_context or {}).get("agent_session_id") or (run_context or {}).get("thread_id")
        candidate_threads = usage_threads or observed_threads
        if requested_thread:
            if requested_thread not in candidate_threads:
                return {
                    "status": "NOT_AVAILABLE",
                    "usage": UsageInfo(collection_status="NOT_AVAILABLE").to_dict(),
                    "agent_session_id": requested_thread,
                    "correlation_confidence": CorrelationConfidence.NOT_AVAILABLE.value,
                    "thread_count": len(candidate_threads),
                    "turn_count": 0,
                }
            turns = {k: v for k, v in turns.items() if k.startswith(f"{requested_thread}:")}
            totals = {
                "input_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
            for usage in turns.values():
                for key in totals:
                    totals[key] += usage.get(key, 0)
            total_tokens = totals["input_tokens"] + totals["output_tokens"]
            has_usage = any(totals.values())
            agent_session_id = requested_thread
            confidence = CorrelationConfidence.EXACT_SESSION_AND_CURSOR.value if has_usage else CorrelationConfidence.NOT_AVAILABLE.value
        elif len(candidate_threads) == 1:
            agent_session_id = next(iter(candidate_threads))
            confidence = CorrelationConfidence.EXACT_SESSION_AND_CURSOR.value if has_usage else CorrelationConfidence.NOT_AVAILABLE.value
        elif len(candidate_threads) > 1:
            return {
                "status": "AMBIGUOUS",
                "usage": UsageInfo(collection_status="AMBIGUOUS", correlation_confidence=CorrelationConfidence.AMBIGUOUS.value).to_dict(),
                "agent_session_id": None,
                "correlation_confidence": CorrelationConfidence.AMBIGUOUS.value,
                "thread_count": len(candidate_threads),
                "turn_count": 0,
            }
        else:
            agent_session_id = None
            confidence = CorrelationConfidence.NOT_AVAILABLE.value

        status = "COMPLETE" if has_usage and malformed == 0 else ("PARTIAL" if has_usage else "NOT_AVAILABLE")
        span = None
        if first_ts and last_ts:
            span = max(0.0, (last_ts - first_ts).total_seconds())

        return {
            "status": status,
            "usage": UsageInfo(
                input_tokens=totals["input_tokens"] if has_usage else None,
                output_tokens=totals["output_tokens"] if has_usage else None,
                reasoning_tokens=totals["reasoning_tokens"] if has_usage else None,
                cache_read_tokens=totals["cache_read_tokens"] if has_usage else None,
                cache_write_tokens=totals["cache_write_tokens"] if has_usage else None,
                total_tokens=total_tokens if has_usage else None,
                collection_status=status,
                source="codex_exec_json",
                correlation_confidence=confidence,
            ).to_dict(),
            "agent_session_id": agent_session_id,
            "correlation_confidence": confidence,
            "observed_model": observed_model,
            "model_event_started_at": first_ts.isoformat() if first_ts else None,
            "model_event_finished_at": last_ts.isoformat() if last_ts else None,
            "model_event_span_seconds": span,
            "thread_count": len(candidate_threads),
            "turn_count": len(turns),
        }
