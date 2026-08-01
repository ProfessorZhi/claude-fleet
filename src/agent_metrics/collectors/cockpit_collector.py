"""
Cockpit Tools Read-Only Collector.
Inspects local Cockpit process and CLIProxy management endpoint (/v0/management).
Strictly enforces Management Key security and avoids destructive usage queue polling during doctor checks.
"""

import os
import json
import socket
import urllib.request
import urllib.parse
from typing import Dict, Any, Optional, Tuple

from agent_metrics.collectors.base import BaseCollector
from agent_metrics.models import CollectorStatus, CockpitConfidence


def is_local_url(url: str) -> bool:
    if not url:
        return False
    parsed = urllib.parse.urlparse(url)
    hostname = (parsed.hostname or "").lower()
    return hostname in ("127.0.0.1", "localhost")


def check_port_listening(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


class CockpitCollector(BaseCollector):
    name = "cockpit"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__()
        self.config = config or {}
        self.base_url = os.environ.get("COCKPIT_BASE_URL") or (self.config.get("base_url") if self.config else None)

    def get_status(self) -> str:
        if self.base_url and is_local_url(self.base_url):
            parsed = urllib.parse.urlparse(self.base_url)
            if parsed.port and check_port_listening("127.0.0.1", parsed.port):
                return CollectorStatus.AVAILABLE.value
        return CollectorStatus.NOT_AVAILABLE.value

    def probe_management_health(self) -> Tuple[bool, Optional[Dict[str, Any]]]:
        if not self.base_url or not is_local_url(self.base_url):
            return False, None

        health_url = f"{self.base_url.rstrip('/')}/v0/management/health"
        req = urllib.request.Request(health_url, method="GET")

        mgmt_key = os.environ.get("COCKPIT_MANAGEMENT_KEY")
        if mgmt_key:
            req.add_header("X-Management-Key", mgmt_key)

        try:
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    return True, data
        except Exception:
            pass
        return False, None

    def collect(self, run_context: Optional[Dict[str, Any]] = None, include_usage_queue: bool = False) -> Dict[str, Any]:
        is_healthy, health_data = self.probe_management_health()

        if not is_healthy:
            return {
                "status": CollectorStatus.NOT_AVAILABLE.value,
                "process_detected": False,
                "cliproxy_detected": False,
                "request_usage_surface": "UNSUPPORTED",
                "quota_surface": "UNSUPPORTED",
                "traffic_proven": False,
                "confidence": CockpitConfidence.NOT_AVAILABLE.value,
            }

        result = {
            "status": CollectorStatus.AVAILABLE.value,
            "process_detected": True,
            "cliproxy_detected": True,
            "health": health_data,
            "quota_surface": "UNSUPPORTED",
            "confidence": CockpitConfidence.CONFIGURED.value,
        }

        if include_usage_queue:
            usage_url = f"{self.base_url.rstrip('/')}/v0/management/usage-queue"
            req = urllib.request.Request(usage_url, method="GET")
            mgmt_key = os.environ.get("COCKPIT_MANAGEMENT_KEY")
            if mgmt_key:
                req.add_header("X-Management-Key", mgmt_key)
            try:
                with urllib.request.urlopen(req, timeout=3.0) as resp:
                    if resp.status == 200:
                        usage_events = json.loads(resp.read().decode("utf-8"))
                        result["request_usage_surface"] = "AVAILABLE"
                        result["usage_events"] = usage_events
                        result["confidence"] = CockpitConfidence.REQUEST_OBSERVED.value
                        return result
            except Exception:
                pass

        result["request_usage_surface"] = "UNSUPPORTED"
        return result
