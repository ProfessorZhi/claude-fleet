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
            is_verified, _ = self.probe_management_status()
            if is_verified:
                return CollectorStatus.AVAILABLE.value
            return CollectorStatus.CONFIG_REQUIRED.value
        return CollectorStatus.NOT_AVAILABLE.value

    def probe_management_status(self) -> Tuple[bool, Optional[Dict[str, Any]]]:
        if not self.base_url or not is_local_url(self.base_url):
            return False, None

        # Non-destructive endpoint check (/v0/management/status or /v0/management/version)
        status_url = f"{self.base_url.rstrip('/')}/v0/management/status"
        req = urllib.request.Request(status_url, method="GET")

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

    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        is_verified, status_data = self.probe_management_status()

        if not is_verified:
            return {
                "status": self.get_status(),
                "process_detected": False,
                "cliproxy_detected": False,
                "request_usage_surface": "UNSUPPORTED",
                "quota_surface": "UNSUPPORTED",
                "traffic_proven": False,
                "confidence": CockpitConfidence.NOT_AVAILABLE.value,
            }

        return {
            "status": CollectorStatus.AVAILABLE.value,
            "process_detected": True,
            "cliproxy_detected": True,
            "status_info": status_data,
            "request_usage_surface": "UNSUPPORTED",
            "quota_surface": "UNSUPPORTED",
            "confidence": CockpitConfidence.CONFIGURED.value,
        }
