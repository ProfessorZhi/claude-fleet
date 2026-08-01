"""
Data integrity and atomic file writing utilities.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Union


def compute_sha256(content: Union[str, bytes]) -> str:
    if isinstance(content, str):
        content = content.encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def compute_dict_sha256(data: dict) -> str:
    canonical_json = json.dumps(data, indent=2, sort_keys=True)
    return compute_sha256(canonical_json)


def atomic_write_file(file_path: Union[str, Path], content: str, encoding: str = "utf-8") -> None:
    target = Path(file_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    temp_file = target.parent / f".{target.name}.tmp_{os.getpid()}"
    try:
        with open(temp_file, "w", encoding=encoding) as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, target)
    except Exception:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass
        raise


def verify_file_sha256(file_path: Union[str, Path], expected_sha256: str) -> bool:
    target = Path(file_path)
    if not target.is_file():
        return False
    content = target.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    return actual.lower() == expected_sha256.lower()
