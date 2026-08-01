"""
Centralized secret redaction engine for agent metrics collector.
"""

import os
import re
from typing import Any, Tuple, List, Set, Dict

# Regex patterns for sensitive items
RE_BEARER = re.compile(r"(?i)bearer\s+[A-Za-z0-9\._\-~+/=]{8,}")
RE_SK_KEY = re.compile(r"sk-[A-Za-z0-9_\-]{20,}")
RE_GOCSPX_KEY = re.compile(r"GOCSPX-[A-Za-z0-9_\-]{10,}")
RE_GITHUB_TOKEN = re.compile(r"(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}")
RE_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
RE_AUTHORIZATION_HEADER = re.compile(r"(?i)(authorization|proxy-authorization)\s*:\s*[^\r\n]+")
RE_COOKIE_HEADER = re.compile(r"(?i)(cookie|set-cookie)\s*:\s*[^\r\n]+")
RE_EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
RE_QUERY_SECRET = re.compile(r"(?i)([?&](?:key|token|secret|auth|access_token|api_key|password|credential)=)[^&\s]+")
RE_LONG_HEX = re.compile(r"(?<![a-fA-F0-9])[a-fA-F0-9]{40,}(?![a-fA-F0-9])")


def get_user_home_patterns() -> List[re.Pattern]:
    patterns = []
    user_dir = os.path.expanduser("~")
    if user_dir:
        # e.g., C:\Users\Administrator or /home/user or /Users/user
        username = os.path.basename(user_dir.rstrip(r"\/"))
        if username and len(username) > 2 and username.lower() not in ("administrator", "admin", "user", "root"):
            patterns.append(re.compile(re.escape(username), re.IGNORECASE))
    return patterns


def scan_text_for_secret_types(text: str) -> Set[str]:
    found = set()
    if RE_BEARER.search(text):
        found.add("Bearer Token")
    if RE_SK_KEY.search(text):
        found.add("sk- API Key")
    if RE_GOCSPX_KEY.search(text):
        found.add("GOCSPX Key")
    if RE_GITHUB_TOKEN.search(text):
        found.add("GitHub Token")
    if RE_JWT.search(text):
        found.add("JWT")
    if RE_AUTHORIZATION_HEADER.search(text):
        found.add("Authorization Header")
    if RE_COOKIE_HEADER.search(text):
        found.add("Cookie Header")
    if RE_EMAIL.search(text):
        found.add("Email Address")
    if RE_QUERY_SECRET.search(text):
        found.add("URL Query Secret")
    return found


def redact_string(text: str) -> Tuple[str, List[str]]:
    if not isinstance(text, str):
        return text, []

    warnings = []
    redacted = text

    found_types = scan_text_for_secret_types(redacted)
    if found_types:
        for t in sorted(found_types):
            warnings.append("secret_like_value_redacted")

    # Apply replacements
    redacted = RE_BEARER.sub("[REDACTED]", redacted)
    redacted = RE_SK_KEY.sub("[REDACTED]", redacted)
    redacted = RE_GOCSPX_KEY.sub("[REDACTED]", redacted)
    redacted = RE_GITHUB_TOKEN.sub("[REDACTED]", redacted)
    redacted = RE_JWT.sub("[REDACTED]", redacted)
    redacted = RE_AUTHORIZATION_HEADER.sub(r"\1: [REDACTED]", redacted)
    redacted = RE_COOKIE_HEADER.sub(r"\1: [REDACTED]", redacted)
    redacted = RE_EMAIL.sub("[REDACTED_EMAIL]", redacted)
    redacted = RE_QUERY_SECRET.sub(r"\1[REDACTED]", redacted)
    redacted = RE_LONG_HEX.sub("[REDACTED_HEX]", redacted)

    return redacted, list(set(warnings))


def redact_data(data: Any) -> Tuple[Any, List[str]]:
    """
    Recursively redact dictionaries, lists, strings.
    Returns (sanitized_data, warnings_list).
    """
    all_warnings: Set[str] = set()

    if isinstance(data, str):
        res, warn = redact_string(data)
        return res, warn
    elif isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            # Check key name for secrets
            key_redacted, k_warn = redact_string(str(k))
            all_warnings.update(k_warn)

            if isinstance(k, str) and any(s in k.lower() for s in ("token", "secret", "password", "authorization", "cookie", "api_key", "management_key")):
                new_dict[k] = "[REDACTED]"
                all_warnings.add("secret_like_value_redacted")
            else:
                val_redacted, v_warn = redact_data(v)
                all_warnings.update(v_warn)
                new_dict[k] = val_redacted
        return new_dict, sorted(list(all_warnings))
    elif isinstance(data, list):
        new_list = []
        for elem in data:
            elem_redacted, e_warn = redact_data(elem)
            all_warnings.update(e_warn)
            new_list.append(elem_redacted)
        return new_list, sorted(list(all_warnings))
    else:
        return data, []
