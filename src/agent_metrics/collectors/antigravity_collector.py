"""
Antigravity usage & metadata collector.
"""

import json
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from .base import BaseCollector
from .cockpit_collector import CockpitCollector
from ..models import CollectorStatus, UsageInfo, ModelConfidence, CorrelationConfidence


class AntigravityCollector(BaseCollector):
    def __init__(self, log_dir: Optional[Path] = None, cockpit_collector: Optional[CockpitCollector] = None):
        if log_dir is None:
            user_home = Path.home()
            log_dir = user_home / ".gemini" / "antigravity" / "logs"
        self.log_dir = log_dir
        self.cockpit_collector = cockpit_collector or CockpitCollector()

    @property
    def name(self) -> str:
        return "antigravity"

    def check_availability(self) -> str:
        if self.log_dir and self.log_dir.exists() and self.log_dir.is_dir():
            return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def scan_antigravity_logs(
        self, started_at: str, finished_at: Optional[str]
    ) -> List[Dict[str, Any]]:
        if not self.log_dir or not self.log_dir.exists():
            return []

        structured_events = []
        for log_file in self.log_dir.glob("*.log"):
            if not log_file.is_file():
                continue
            try:
                with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("{") and line.endswith("}"):
                            try:
                                data = json.loads(line)
                                if isinstance(data, dict) and ("usage" in data or "model" in data or "token_count" in data):
                                    structured_events.append(data)
                            except Exception:
                                pass
            except Exception:
                continue
        return structured_events

    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        started_at = run_context.get("started_at", "")
        finished_at = run_context.get("finished_at")
        configured_model = run_context.get("configured_model")

        # Priority 1: Cockpit CLIProxy Request Usage
        events, event_conf = self.cockpit_collector.fetch_cliproxy_usage_events(started_at, finished_at)
        if events:
            # Filter events matching provider / model / timeframe
            total_in = 0
            total_out = 0
            total_reasoning = 0
            cache_read = 0
            cache_write = 0
            observed_model = None

            for ev in events:
                u = ev.get("usage", ev)
                total_in += u.get("input_tokens", 0) or 0
                total_out += u.get("output_tokens", 0) or 0
                total_reasoning += u.get("reasoning_tokens", 0) or 0
                cache_read += u.get("cache_read_tokens", 0) or 0
                cache_write += u.get("cache_write_tokens", 0) or 0
                if not observed_model:
                    observed_model = ev.get("model") or u.get("model")

            total_tokens = total_in + total_out
            usage = UsageInfo(
                input_tokens=total_in,
                output_tokens=total_out,
                reasoning_tokens=total_reasoning,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
                total_tokens=total_tokens,
                collection_status="COMPLETE",
                source="cliproxy_usage_event",
                correlation_confidence=CorrelationConfidence.TIME_WINDOW_MATCH.value,
            )

            return {
                "usage": usage.to_dict(),
                "model_info": {
                    "configured_model": configured_model,
                    "requested_model": configured_model,
                    "observed_model": observed_model or configured_model,
                    "detection_source": "cliproxy_usage_event",
                    "detection_confidence": ModelConfidence.OBSERVED.value,
                },
            }

        # Priority 2: Antigravity Log Usage
        ag_logs = self.scan_antigravity_logs(started_at, finished_at)
        if ag_logs:
            # Parse log usage
            total_in = 0
            total_out = 0
            observed_model = None

            for ev in ag_logs:
                u = ev.get("usage", {})
                total_in += u.get("input_tokens", 0) or 0
                total_out += u.get("output_tokens", 0) or 0
                if not observed_model:
                    observed_model = ev.get("model") or u.get("model")

            total_tokens = total_in + total_out
            usage = UsageInfo(
                input_tokens=total_in,
                output_tokens=total_out,
                total_tokens=total_tokens,
                collection_status="COMPLETE",
                source="antigravity_log",
                correlation_confidence=CorrelationConfidence.TIME_WINDOW_MATCH.value,
            )

            return {
                "usage": usage.to_dict(),
                "model_info": {
                    "configured_model": configured_model,
                    "requested_model": configured_model,
                    "observed_model": observed_model or configured_model,
                    "detection_source": "antigravity_log",
                    "detection_confidence": ModelConfidence.OBSERVED.value,
                },
            }

        # Priority 3/4: Cockpit Quota only
        quota_data, quota_conf = self.cockpit_collector.fetch_quota_snapshot()
        if quota_data:
            usage = UsageInfo(
                input_tokens=None,
                output_tokens=None,
                total_tokens=None,
                collection_status="NOT_AVAILABLE",
                source="cockpit_quota",
                correlation_confidence="QUOTA_ONLY",
            )
            return {
                "usage": usage.to_dict(),
                "model_info": {
                    "configured_model": configured_model,
                    "requested_model": configured_model,
                    "observed_model": None,
                    "detection_source": "cockpit_quota",
                    "detection_confidence": ModelConfidence.CONFIGURED.value,
                },
            }

        # Priority 5: Configured Model only / Not Available
        usage = UsageInfo(
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            collection_status="NOT_AVAILABLE",
            source=None,
            correlation_confidence=CorrelationConfidence.NOT_AVAILABLE.value,
        )
        return {
            "usage": usage.to_dict(),
            "model_info": {
                "configured_model": configured_model,
                "requested_model": configured_model,
                "observed_model": None,
                "detection_source": "configured",
                "detection_confidence": ModelConfidence.CONFIGURED.value if configured_model else ModelConfidence.NOT_AVAILABLE.value,
            },
        }
