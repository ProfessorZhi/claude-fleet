"""
Read-only Cockpit Tools & CLIProxy collector.
"""

import json
import os
import shutil
import socket
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from .base import BaseCollector
from ..models import CollectorStatus, CockpitConfidence, QuotaSnapshot


class CockpitCollector(BaseCollector):
    def __init__(
        self,
        override_base_url: Optional[str] = None,
        override_process_running: Optional[bool] = None,
        override_cliproxy_running: Optional[bool] = None,
    ):
        self.override_base_url = override_base_url
        self.override_process_running = override_process_running
        self.override_cliproxy_running = override_cliproxy_running

    @property
    def name(self) -> str:
        return "cockpit"

    def get_base_url(self) -> Optional[str]:
        if self.override_base_url:
            return self.override_base_url
        env_url = os.environ.get("COCKPIT_BASE_URL")
        if env_url:
            return env_url
        # Search common default ports
        for port in [8314, 8315, 9090, 18314]:
            if self._is_port_listening(port):
                return f"http://127.0.0.1:{port}"
        return None

    def _is_port_listening(self, port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                res = s.connect_ex(("127.0.0.1", port))
                return res == 0
        except Exception:
            return False

    def is_cockpit_process_running(self) -> bool:
        if self.override_process_running is not None:
            return self.override_process_running
        return self._check_process_names(["Cockpit.exe", "cockpit.exe"])

    def is_cliproxy_process_running(self) -> bool:
        if self.override_cliproxy_running is not None:
            return self.override_cliproxy_running
        return self._check_process_names(["cockpit-cliproxy.exe", "cliproxy.exe"])

    def _check_process_names(self, names: List[str]) -> bool:
        if shutil.which("tasklist") is None:
            return False
        try:
            res = subprocess.run(
                ["tasklist"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
            )
            if res.returncode == 0:
                output = res.stdout.lower()
                return any(name.lower() in output for name in names)
            return False
        except Exception:
            return False

    def check_availability(self) -> str:
        cockpit_run = self.is_cockpit_process_running()
        cliproxy_run = self.is_cliproxy_process_running()
        base_url = self.get_base_url()

        if cliproxy_run and base_url:
            return CollectorStatus.AVAILABLE.value
        elif cockpit_run or base_url:
            return CollectorStatus.CONFIG_REQUIRED.value
        return CollectorStatus.NOT_AVAILABLE.value

    def fetch_quota_snapshot(self) -> Tuple[Optional[Dict[str, Any]], str]:
        base_url = self.get_base_url()
        if not base_url:
            return None, CockpitConfidence.NOT_AVAILABLE.value

        mgmt_key = os.environ.get("COCKPIT_MANAGEMENT_KEY", "")
        headers = {}
        if mgmt_key:
            headers["X-Management-Key"] = mgmt_key

        url = f"{base_url.rstrip('/')}/api/v1/quota"
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data, CockpitConfidence.QUOTA_OBSERVED.value
        except Exception:
            pass

        return None, CockpitConfidence.NOT_AVAILABLE.value

    def fetch_cliproxy_usage_events(
        self, started_at: str, finished_at: Optional[str]
    ) -> Tuple[List[Dict[str, Any]], str]:
        base_url = self.get_base_url()
        if not base_url:
            return [], CockpitConfidence.NOT_AVAILABLE.value

        mgmt_key = os.environ.get("COCKPIT_MANAGEMENT_KEY", "")
        headers = {}
        if mgmt_key:
            headers["X-Management-Key"] = mgmt_key

        url = f"{base_url.rstrip('/')}/api/v1/usage/events"
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    if isinstance(data, list):
                        return data, CockpitConfidence.REQUEST_OBSERVED.value
                    elif isinstance(data, dict) and "events" in data:
                        return data["events"], CockpitConfidence.REQUEST_OBSERVED.value
        except Exception:
            pass

        return [], CockpitConfidence.NOT_AVAILABLE.value

    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        quota_data, quota_conf = self.fetch_quota_snapshot()
        events, event_conf = self.fetch_cliproxy_usage_events(
            started_at=run_context.get("started_at", ""),
            finished_at=run_context.get("finished_at"),
        )

        quota_snapshot = QuotaSnapshot(
            before=quota_data.get("before") if quota_data else None,
            after=quota_data.get("after") if quota_data else None,
            delta=quota_data.get("delta") if quota_data else None,
            reset_time=quota_data.get("reset_time") if quota_data else None,
            subscription_tier=quota_data.get("subscription_tier") if quota_data else None,
            source="cockpit_api" if quota_data else None,
        )

        return {
            "quota": quota_snapshot.to_dict(),
            "events_count": len(events),
            "confidence": event_conf if events else quota_conf,
            "cliproxy_running": self.is_cliproxy_process_running(),
            "cockpit_running": self.is_cockpit_process_running(),
        }
