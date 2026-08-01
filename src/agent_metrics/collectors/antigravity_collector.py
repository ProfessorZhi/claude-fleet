"""
Antigravity Telemetry Collector.
Correlates Antigravity agent usage events strictly against run window and metadata.
Enforces fail-closed correlation on ambiguity.
"""

from typing import Dict, Any, List, Optional

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import (
    CollectorStatus,
    ModelConfidence,
    CorrelationConfidence,
    UsageInfo,
)


class AntigravityCollector(BaseCollector):
    name = "antigravity"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}

    def get_status(self) -> str:
        # Returns NOT_AVAILABLE unless a real persistent telemetry source is configured
        return CollectorStatus.NOT_AVAILABLE.value

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "status": CollectorStatus.NOT_AVAILABLE.value,
            "usage": UsageInfo(collection_status="NOT_AVAILABLE").to_dict(),
        }

    def correlate_usage(
        self,
        candidate_events: List[Dict[str, Any]],
        started_at: str,
        finished_at: Optional[str],
        expected_provider: Optional[str] = None,
        expected_model: Optional[str] = None,
        active_runs_count: int = 1,
        session_id: Optional[str] = None,
    ) -> UsageInfo:
        if not candidate_events:
            return UsageInfo(
                collection_status="NOT_AVAILABLE",
                correlation_confidence=CorrelationConfidence.NOT_AVAILABLE.value,
            )

        if active_runs_count > 1:
            return UsageInfo(
                input_tokens=None,
                output_tokens=None,
                reasoning_tokens=None,
                cache_read_tokens=None,
                cache_write_tokens=None,
                total_tokens=None,
                collection_status="NOT_AVAILABLE",
                source="antigravity_telemetry",
                correlation_confidence=CorrelationConfidence.AMBIGUOUS.value,
            )

        valid_events = []
        for ev in candidate_events:
            ts = ev.get("timestamp")
            if not ts:
                # Reject event lacking timestamp
                continue
            if ts < started_at or (finished_at and ts > finished_at):
                continue

            provider = ev.get("provider")
            if expected_provider and not provider:
                continue
            if expected_provider and provider and provider.lower() != expected_provider.lower():
                continue

            model = ev.get("model")
            if expected_model and not model:
                continue
            if expected_model and model and model.lower() != expected_model.lower():
                continue

            valid_events.append(ev)

        if not valid_events:
            return UsageInfo(
                collection_status="NOT_AVAILABLE",
                correlation_confidence=CorrelationConfidence.NOT_AVAILABLE.value,
            )

        total_input = 0
        total_output = 0
        total_reasoning = 0
        total_cache_read = 0
        total_cache_write = 0

        for ev in valid_events:
            total_input += ev.get("input_tokens", 0) or 0
            total_output += ev.get("output_tokens", 0) or 0
            total_reasoning += ev.get("reasoning_tokens", 0) or 0
            total_cache_read += ev.get("cache_read_tokens", 0) or 0
            total_cache_write += ev.get("cache_write_tokens", 0) or 0

        total_tokens = total_input + total_output

        confidence = CorrelationConfidence.EXACT_SESSION.value if session_id else CorrelationConfidence.TIME_WINDOW_MATCH.value

        return UsageInfo(
            input_tokens=total_input,
            output_tokens=total_output,
            reasoning_tokens=total_reasoning,
            cache_read_tokens=total_cache_read,
            cache_write_tokens=total_cache_write,
            total_tokens=total_tokens,
            collection_status="COMPLETE",
            source="antigravity_telemetry",
            correlation_confidence=confidence,
        )
