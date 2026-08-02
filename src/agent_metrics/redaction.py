"""
Privacy Redaction Engine and Field-Aware Sanitization.
Redacts API keys, Bearer tokens, JWTs, OAuth credentials, emails, and sensitive headers.
Preserves metric fields, SHA hashes, UUIDs, and Git commit SHAs.
"""

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Set

# Field Classifications
ALLOWLISTED_METRIC_FIELDS = {
    "schema_version",
    "collector_version",
    "run_id",
    "work_package",
    "pr_number",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "wall_clock_seconds",
    "agent_process_seconds",
    "model_event_started_at",
    "model_event_finished_at",
    "model_event_span_seconds",
    "ci_queued_at",
    "ci_queue_seconds",
    "ci_run_seconds",
    "agent_active_seconds",
    "ci_wait_seconds",
    "workflow_duration_seconds",
    "commit_count",
    "files_changed",
    "changed_files",
    "additions",
    "deletions",
    "round_commit_count",
    "round_changed_files",
    "round_additions",
    "round_deletions",
    "unstaged_changes",
    "staged_changes",
    "untracked_files",
    "price_snapshot_date",
    "price_snapshot_version",
    "currency",
    "api_equivalent_cost_usd",
    "actual_billed_cost_usd",
    "payload_sha256",
    "file_sha256",
    "started_at",
    "finished_at",
    "shell",
    "provider",
    "configured_model",
    "requested_model",
    "observed_model",
    "inferred_model",
    "model_detection_source",
    "model_detection_confidence",
    "permission_mode",
    "collection_status",
    "correlation_confidence",
    "status",
    "state",
    "is_draft",
    "clean",
    "initial_clean",
    "final_clean",
    "initial_branch",
    "final_branch",
    "base_branch",
    "head_branch",
    "initial_head_sha",
    "final_head_sha",
    "github_head_sha",
    "ci_run_id",
    "ci_started_at",
    "ci_completed_at",
    "ci_result",
    "warnings",
    "collectors",
}

DROP_CONTENT_FIELDS = {
    "prompt",
    "messages",
    "message",
    "content",
    "text",
    "assistant_response",
    "request_body",
    "response_body",
    "source_code",
    "diff_content",
    "tool_input",
    "tool_output",
}

SECRET_KEY_PATTERNS = {
    r".*management_key.*",
    r".*api_key.*",
    r".*secret.*",
    r".*password.*",
    r".*authorization.*",
    r".*cookie.*",
    r".*bearer.*",
    r".*access_token.*",
}

RE_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9\-\._~\+\/]{15,}=*", re.IGNORECASE)
RE_SK_API_KEY = re.compile(r"sk-[A-Za-z0-9]{20,}")
RE_GOCSPX = re.compile(r"GOCSPX-[A-Za-z0-9_-]{20,}")
RE_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
RE_EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
RE_QUERY_SECRET = re.compile(r"((?:api_key|token|secret|password|key)=)[^\s&]+", re.IGNORECASE)
RE_AUTH_HEADER = re.compile(r"(?:Authorization|Cookie|X-Api-Key):\s*([^\r\n]+)", re.IGNORECASE)

# Valid Non-Secret Identifiers
RE_COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
RE_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
RE_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def get_home_username() -> str:
    user = os.environ.get("USERNAME") or os.environ.get("USER")
    return user if user else ""


def get_home_candidates() -> List[str]:
    candidates = []
    try:
        h = str(Path.home())
        if h:
            candidates.append(h)
    except Exception:
        pass
    for env_var in ("USERPROFILE", "HOME"):
        val = os.environ.get(env_var)
        if val:
            candidates.append(val)

    unique = []
    seen = set()
    for c in candidates:
        if not c:
            continue
        c_clean = c.rstrip("/\\")
        if c_clean and c_clean.lower() not in seen:
            seen.add(c_clean.lower())
            unique.append(c_clean)
    return unique


def redact_home_path(text: str) -> str:
    if not isinstance(text, str):
        return text

    for candidate in get_home_candidates():
        bs = candidate.replace("/", "\\")
        fs = candidate.replace("\\", "/")
        for path_form in (bs, fs):
            if path_form:
                text = re.sub(re.escape(path_form), "[HOME]", text, flags=re.IGNORECASE)

    user = get_home_username()
    if user and len(user) > 2:
        text = re.sub(
            rf"(?:Users|home)[/\\]{re.escape(user)}",
            r"[HOME]",
            text,
            flags=re.IGNORECASE,
        )
    return text


def redact_text(text: str) -> str:
    if not isinstance(text, str):
        return text

    # Do not redact if text is a clean Git SHA, SHA-256, or UUID
    s = text.strip()
    if RE_COMMIT_SHA.match(s) or RE_SHA256.match(s) or RE_UUID.match(s):
        return s

    text = RE_BEARER.sub("Bearer [REDACTED]", text)
    text = RE_SK_API_KEY.sub("[REDACTED_API_KEY]", text)
    text = RE_GOCSPX.sub("[REDACTED_GOCSPX]", text)
    text = RE_JWT.sub("[REDACTED_JWT]", text)
    text = RE_EMAIL.sub("[REDACTED_EMAIL]", text)
    text = RE_QUERY_SECRET.sub(r"\1[REDACTED]", text)
    text = redact_home_path(text)

    return text


def scan_text_for_secret_types(text: str) -> Set[str]:
    found = set()
    if not isinstance(text, str):
        return found

    if RE_BEARER.search(text):
        found.add("Bearer Token")
    if RE_SK_API_KEY.search(text):
        found.add("sk- API Key")
    if RE_GOCSPX.search(text):
        found.add("GOCSPX Key")
    if RE_JWT.search(text):
        found.add("JWT")
    if RE_EMAIL.search(text):
        found.add("Email Address")
    if RE_QUERY_SECRET.search(text):
        found.add("URL Query Secret")
    if RE_AUTH_HEADER.search(text):
        found.add("Authorization Header")
    return found


def sanitize_dict(data: Any) -> Any:
    if isinstance(data, dict):
        cleaned = {}
        for k, v in data.items():
            k_lower = k.lower()
            if k_lower in DROP_CONTENT_FIELDS:
                continue  # Completely drop content fields

            if k_lower in ALLOWLISTED_METRIC_FIELDS:
                # Metric fields are preserved as-is if numeric or string
                if isinstance(v, (dict, list)):
                    cleaned[k] = sanitize_dict(v)
                elif isinstance(v, str):
                    cleaned[k] = redact_home_path(v)
                else:
                    cleaned[k] = v
            else:
                # Check if key implies secret
                is_secret_key = any(re.match(p, k_lower) for p in SECRET_KEY_PATTERNS)
                if is_secret_key:
                    cleaned[k] = "[REDACTED]"
                else:
                    cleaned[k] = sanitize_dict(v)
        return cleaned
    elif isinstance(data, list):
        return [sanitize_dict(item) for item in data]
    elif isinstance(data, str):
        return redact_text(data)
    else:
        return data
