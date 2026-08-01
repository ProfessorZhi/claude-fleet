"""
Storage manager for local run telemetry and artifacts (.local/runs/<RUN_ID>/).
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple, Union

from .integrity import atomic_write_file, compute_sha256, compute_dict_sha256
from .models import SanitizedSummary, EXIT_STORAGE_ERROR, EXIT_INVALID_INPUT

WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
}

SAFE_RUN_ID_REGEX = re.compile(r"^[a-zA-Z0-9_\-]+$")


class StorageManager:
    def __init__(self, base_dir: Optional[Union[str, Path]] = None):
        if base_dir is None:
            # Default to project_root/.local/runs
            project_root = Path(__file__).resolve().parent.parent.parent
            self.base_dir = project_root / ".local" / "runs"
        else:
            self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def validate_run_id(self, run_id: str) -> None:
        if not run_id or not isinstance(run_id, str):
            raise ValueError(f"Invalid run_id: {run_id}")
        if (
            not SAFE_RUN_ID_REGEX.match(run_id)
            or ".." in run_id
            or "/" in run_id
            or "\\" in run_id
            or run_id.upper() in WINDOWS_RESERVED_NAMES
        ):
            raise ValueError(f"Invalid or unsafe run_id: {run_id}")

    def get_run_dir(self, run_id: str) -> Path:
        self.validate_run_id(run_id)
        run_dir = (self.base_dir / run_id).resolve()
        # Verify run_dir is strictly inside base_dir
        if not str(run_dir).startswith(str(self.base_dir)):
            raise ValueError(f"Path traversal detected for run_id: {run_id}")
        return run_dir

    def init_run(self, run_context: Dict[str, Any]) -> Tuple[Path, str]:
        run_id = run_context.get("run_id")
        if not run_id:
            run_id = str(uuid.uuid4())
            run_context["run_id"] = run_id

        run_dir = self.get_run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)

        # Write run-context.json atomically
        context_file = run_dir / "run-context.json"
        content = json.dumps(run_context, indent=2, sort_keys=True)
        atomic_write_file(context_file, content)

        # Ensure events.jsonl exists
        events_file = run_dir / "events.jsonl"
        if not events_file.exists():
            events_file.touch()

        # Log start event
        self.append_event(
            run_id=run_id,
            event_type="RUN_STARTED",
            source="CLI",
            payload={"work_package": run_context.get("work_package"), "agent": run_context.get("agent")},
        )

        return run_dir, run_id

    def read_run_context(self, run_id: str) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        context_file = run_dir / "run-context.json"
        if not context_file.is_file():
            raise FileNotFoundError(f"Run context not found for run_id: {run_id}")
        with open(context_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def write_run_context(self, run_id: str, run_context: Dict[str, Any]) -> None:
        run_dir = self.get_run_dir(run_id)
        context_file = run_dir / "run-context.json"
        content = json.dumps(run_context, indent=2, sort_keys=True)
        atomic_write_file(context_file, content)

    def append_event(self, run_id: str, event_type: str, source: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        events_file = run_dir / "events.jsonl"

        event_id = str(uuid.uuid4())
        observed_at = datetime.now(timezone.utc).isoformat()
        payload_hash = compute_dict_sha256(payload)

        event = {
            "event_id": event_id,
            "event_type": event_type,
            "observed_at": observed_at,
            "source": source,
            "payload_hash": payload_hash,
            "payload": payload,
        }

        line = json.dumps(event, sort_keys=True) + "\n"
        with open(events_file, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())

        return event

    def write_raw_observation(self, run_id: str, observation: Dict[str, Any]) -> Path:
        run_dir = self.get_run_dir(run_id)
        raw_file = run_dir / "raw-observation.local.json"
        content = json.dumps(observation, indent=2, sort_keys=True)
        atomic_write_file(raw_file, content)
        return raw_file

    def write_sanitized_summary(self, run_id: str, summary_data: Dict[str, Any]) -> Tuple[Path, Path, str]:
        run_dir = self.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        sha_file = run_dir / "sanitized-summary.sha256"

        # Calculate SHA-256 without integrity field first
        temp_data = dict(summary_data)
        if "integrity" in temp_data:
            temp_data["integrity"] = {"summary_sha256": None}

        content_str = json.dumps(temp_data, indent=2, sort_keys=True)
        summary_sha = compute_sha256(content_str)

        # Update integrity field in summary_data
        summary_data["integrity"] = {"summary_sha256": summary_sha}
        final_content = json.dumps(summary_data, indent=2, sort_keys=True)

        atomic_write_file(summary_file, final_content)
        atomic_write_file(sha_file, f"{summary_sha}\n")

        return summary_file, sha_file, summary_sha

    def read_sanitized_summary(self, run_id: str) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        if not summary_file.is_file():
            raise FileNotFoundError(f"Sanitized summary not found for run_id: {run_id}")
        with open(summary_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def read_sanitized_summary_sha256(self, run_id: str) -> Optional[str]:
        run_dir = self.get_run_dir(run_id)
        sha_file = run_dir / "sanitized-summary.sha256"
        if not sha_file.is_file():
            return None
        return sha_file.read_text(encoding="utf-8").strip()
