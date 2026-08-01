"""
Atomic storage manager for agent metrics collector.
Stores run context, events log, and sanitized summary in .local/runs/<RUN_ID>/.
"""

import json
import os
import re
import uuid
import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional

from agent_metrics.models import SanitizedSummary
from agent_metrics.redaction import sanitize_dict, scan_text_for_secret_types
from agent_metrics.integrity import compute_payload_sha256, compute_file_sha256, verify_summary_integrity
from agent_metrics.validators import validate_run_context, validate_sanitized_summary

# Strict run_id pattern: the ENTIRE string must consist only of alphanumerics, hyphens, underscores.
# No leading/trailing whitespace, no embedded newlines, no quotes, no extra content permitted.
RE_RUN_ID = re.compile(r"^[a-zA-Z0-9_\-]+$")
RESERVED_DEVICE_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
}


class StorageError(Exception):
    pass


class IntegrityError(Exception):
    pass


class StorageManager:
    def __init__(self, base_dir: Optional[str] = None):
        if base_dir:
            self.base_dir = Path(base_dir).resolve()
        else:
            self.base_dir = Path(__file__).resolve().parent.parent.parent / ".local" / "runs"
        self.base_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def validate_run_id(run_id: str) -> None:
        """Strictly validate run_id as a complete, unmodified string.

        The ENTIRE input string must match the run_id pattern.
        Any embedded whitespace, newlines, quotes, or extra content cause rejection.
        No truncation, stripping, or extraction is performed.
        """
        if not run_id or not isinstance(run_id, str):
            raise ValueError("run_id must be a non-empty string")
        # re.fullmatch requires the ENTIRE string to match — no truncation permitted.
        if not re.fullmatch(r"[a-zA-Z0-9_\-]+", run_id):
            raise ValueError(f"Invalid or unsafe run_id: {run_id!r}")
        if run_id.upper() in RESERVED_DEVICE_NAMES:
            raise ValueError(f"run_id matches reserved device name: {run_id!r}")

    @staticmethod
    def validate_work_package(work_package: str) -> None:
        if not isinstance(work_package, str):
            raise ValueError("work_package must be a string")
        if len(work_package) > 128:
            raise ValueError("work_package length exceeds 128 characters")
        if "\n" in work_package or "\r" in work_package:
            raise ValueError("work_package cannot contain newline characters")

        secrets = scan_text_for_secret_types(work_package)
        if secrets:
            raise ValueError(f"work_package contains secret-like values: {secrets}")

    def get_run_dir(self, run_id: str) -> Path:
        self.validate_run_id(run_id)
        run_dir = (self.base_dir / run_id).resolve()
        if not str(run_dir).startswith(str(self.base_dir)):
            raise ValueError(f"Path traversal detected for run_id: {run_id!r}")
        return run_dir

    def summary_exists(self, run_id: str) -> bool:
        """Return True if sanitized-summary.json exists for the given run_id.
        Does NOT read or validate the file — only checks existence.
        """
        try:
            run_dir = self.get_run_dir(run_id)
        except (ValueError, Exception):
            return False
        return (run_dir / "sanitized-summary.json").exists()

    @staticmethod
    def atomic_write(file_path: Path, data: bytes) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = file_path.with_suffix(".tmp." + uuid.uuid4().hex[:8])
        try:
            with open(tmp_path, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, file_path)
        except Exception as e:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass
            raise StorageError(f"Failed atomic write to {file_path}: {e}") from e

    def create_run(self, run_context: Dict[str, Any]) -> str:
        run_id = run_context.get("run_id") or str(uuid.uuid4())
        self.validate_run_id(run_id)
        work_package = run_context.get("work_package", "")
        if work_package:
            self.validate_work_package(work_package)

        run_dir = self.get_run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)

        sanitized_ctx = sanitize_dict(run_context)
        sanitized_ctx["run_id"] = run_id
        if "work_package" not in sanitized_ctx or sanitized_ctx["work_package"] is None:
            sanitized_ctx["work_package"] = ""
        if "schema_version" not in sanitized_ctx:
            sanitized_ctx["schema_version"] = 1
        if "collector_version" not in sanitized_ctx:
            sanitized_ctx["collector_version"] = "0.1.0"

        validate_run_context(sanitized_ctx)

        ctx_file = run_dir / "run-context.json"
        data_bytes = json.dumps(sanitized_ctx, indent=2, ensure_ascii=False).encode("utf-8")
        self.atomic_write(ctx_file, data_bytes)

        self.append_event(run_id, {
            "type": "RUN_STARTED",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "run_id": run_id,
            "work_package": work_package
        })

        return run_id

    def init_run(self, run_context: Dict[str, Any]) -> str:
        return self.create_run(run_context)

    def read_run_context(self, run_id: str) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        ctx_file = run_dir / "run-context.json"
        if not ctx_file.exists():
            raise StorageError(f"Run context not found for run_id: {run_id}")
        try:
            with open(ctx_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            validate_run_context(data)
            return data
        except Exception as e:
            raise StorageError(f"Error reading run context for ID {run_id!r}: {e}") from e

    def append_event(self, run_id: str, event: Dict[str, Any]) -> None:
        run_dir = self.get_run_dir(run_id)
        events_file = run_dir / "events.jsonl"
        sanitized_event = sanitize_dict(event)

        line = json.dumps(sanitized_event, ensure_ascii=False) + "\n"
        try:
            with open(events_file, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
        except Exception as e:
            raise StorageError(f"Failed to append event to {events_file}: {e}") from e

    def read_events(self, run_id: str) -> List[Dict[str, Any]]:
        run_dir = self.get_run_dir(run_id)
        events_file = run_dir / "events.jsonl"
        if not events_file.exists():
            return []
        events = []
        with open(events_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        pass
        return events

    def write_sanitized_summary(self, run_id: str, summary_dict: Dict[str, Any], overwrite: bool = False) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        sha_file = run_dir / "sanitized-summary.sha256"

        if summary_file.exists() and not overwrite:
            return self.read_sanitized_summary(run_id)

        sanitized = sanitize_dict(summary_dict)

        payload_sha = compute_payload_sha256(sanitized)
        if "integrity" not in sanitized or not isinstance(sanitized["integrity"], dict):
            sanitized["integrity"] = {}
        sanitized["integrity"]["payload_sha256"] = payload_sha

        validate_sanitized_summary(sanitized)

        summary_bytes = json.dumps(sanitized, indent=2, ensure_ascii=False).encode("utf-8")
        self.atomic_write(summary_file, summary_bytes)

        file_sha = compute_file_sha256(summary_bytes)
        self.atomic_write(sha_file, (file_sha + "\n").encode("utf-8"))

        return sanitized

    def read_sanitized_summary(self, run_id: str) -> Dict[str, Any]:
        run_dir = self.get_run_dir(run_id)
        summary_file = run_dir / "sanitized-summary.json"
        sha_file = run_dir / "sanitized-summary.sha256"

        if not summary_file.exists():
            raise StorageError(f"Sanitized summary not found for run_id: {run_id}")

        try:
            with open(summary_file, "rb") as f:
                summary_bytes = f.read()
            summary_dict = json.loads(summary_bytes.decode("utf-8"))
        except Exception as e:
            raise StorageError(f"Error reading summary file for run_id {run_id}: {e}") from e

        # Sidecar MUST be present — its absence is treated as an integrity failure.
        if not sha_file.exists():
            raise IntegrityError(
                f"SHA-256 sidecar missing for run_id {run_id}: "
                "sanitized-summary.sha256 not found alongside sanitized-summary.json"
            )
        try:
            expected_file_sha = sha_file.read_text(encoding="utf-8").strip()
        except Exception as e:
            raise IntegrityError(f"Failed to read SHA-256 sidecar for run_id {run_id}: {e}") from e

        is_valid, msg = verify_summary_integrity(summary_dict, summary_bytes, expected_file_sha)
        if not is_valid:
            raise IntegrityError(f"Summary integrity verification failed for run_id {run_id}: {msg}")

        validate_sanitized_summary(summary_dict)
        return summary_dict


    def read_sanitized_summary_sha256(self, run_id: str) -> Optional[str]:
        run_dir = self.get_run_dir(run_id)
        sha_file = run_dir / "sanitized-summary.sha256"
        if sha_file.exists():
            return sha_file.read_text(encoding="utf-8").strip()
        return None
