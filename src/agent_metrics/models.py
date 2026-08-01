"""
Data models, enums, and exit codes for agent metrics collector.
"""

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, List, Dict, Any

# Standard Exit Codes
EXIT_OK = 0
EXIT_PARTIAL = 2
EXIT_INVALID_INPUT = 4
EXIT_STORAGE_ERROR = 5
EXIT_INTEGRITY_ERROR = 6
EXIT_EXTERNAL_CMD_ERROR = 7


class ModelConfidence(str, Enum):
    OBSERVED = "OBSERVED"
    REQUESTED = "REQUESTED"
    CONFIGURED = "CONFIGURED"
    INFERRED = "INFERRED"
    NOT_AVAILABLE = "NOT_AVAILABLE"


class CockpitConfidence(str, Enum):
    REQUEST_OBSERVED = "REQUEST_OBSERVED"
    QUOTA_OBSERVED = "QUOTA_OBSERVED"
    CONFIGURED = "CONFIGURED"
    NOT_AVAILABLE = "NOT_AVAILABLE"


class CorrelationConfidence(str, Enum):
    EXACT_SESSION = "EXACT_SESSION"
    EXACT_WORKTREE = "EXACT_WORKTREE"
    EXACT_WORK_PACKAGE = "EXACT_WORK_PACKAGE"
    TIME_WINDOW_MATCH = "TIME_WINDOW_MATCH"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_AVAILABLE = "NOT_AVAILABLE"
    QUOTA_ONLY = "QUOTA_ONLY"


class CollectorStatus(str, Enum):
    AVAILABLE = "AVAILABLE"
    CONFIG_REQUIRED = "CONFIG_REQUIRED"
    NOT_AVAILABLE = "NOT_AVAILABLE"
    UNSUPPORTED = "UNSUPPORTED"
    ERROR = "ERROR"


@dataclass
class AgentInfo:
    shell: str
    provider: str
    configured_model: Optional[str] = None
    requested_model: Optional[str] = None
    observed_model: Optional[str] = None
    inferred_model: Optional[str] = None
    model_detection_source: Optional[str] = None
    model_detection_confidence: str = ModelConfidence.NOT_AVAILABLE.value
    permission_mode: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class TimingInfo:
    started_at: str
    finished_at: Optional[str] = None
    wall_clock_seconds: Optional[float] = None
    agent_active_seconds: Optional[float] = None  # Always null unless explicit telemetry
    ci_wait_seconds: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class UsageInfo:
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    cache_write_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    collection_status: str = "NOT_AVAILABLE"
    source: Optional[str] = None
    correlation_confidence: str = CorrelationConfidence.NOT_AVAILABLE.value

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PricingInfo:
    price_snapshot_date: Optional[str] = None
    price_source: Optional[str] = None
    currency: str = "USD"
    api_equivalent_cost_usd: Optional[float] = None
    actual_billed_cost_usd: Optional[float] = None  # Always null unless explicit real bill provided
    status: str = "PRICE_NOT_AVAILABLE"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class QuotaSnapshot:
    before: Optional[Any] = None
    after: Optional[Any] = None
    delta: Optional[Any] = None
    reset_time: Optional[str] = None
    subscription_tier: Optional[str] = None
    source: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class GitInfo:
    initial_branch: Optional[str] = None
    initial_head_sha: Optional[str] = None
    initial_clean: Optional[bool] = None
    final_branch: Optional[str] = None
    final_head_sha: Optional[str] = None
    final_clean: Optional[bool] = None
    commit_count: Optional[int] = None
    files_changed: Optional[int] = None
    additions: Optional[int] = None
    deletions: Optional[int] = None
    round_commit_count: Optional[int] = None
    round_changed_files: Optional[int] = None
    round_additions: Optional[int] = None
    round_deletions: Optional[int] = None
    unstaged_changes: Optional[int] = None
    staged_changes: Optional[int] = None
    untracked_files: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class GithubInfo:
    pr_number: Optional[int] = None
    pr_url: Optional[str] = None
    base_branch: Optional[str] = None
    head_branch: Optional[str] = None
    github_head_sha: Optional[str] = None
    state: Optional[str] = None
    is_draft: Optional[bool] = None
    commit_count: Optional[int] = None
    changed_files: Optional[int] = None
    additions: Optional[int] = None
    deletions: Optional[int] = None
    ci_run_id: Optional[str] = None
    ci_started_at: Optional[str] = None
    ci_completed_at: Optional[str] = None
    workflow_duration_seconds: Optional[float] = None
    ci_wait_seconds: Optional[float] = None
    ci_result: Optional[str] = None
    status: str = "NOT_AVAILABLE"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class IntegrityInfo:
    payload_sha256: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SanitizedSummary:
    schema_version: int = 1
    collector_version: str = "0.1.0"
    run_id: str = ""
    work_package: str = ""
    pr_number: Optional[int] = None
    agent: AgentInfo = field(default_factory=lambda: AgentInfo(shell="", provider=""))
    timing: TimingInfo = field(default_factory=lambda: TimingInfo(started_at=""))
    usage: UsageInfo = field(default_factory=UsageInfo)
    pricing: PricingInfo = field(default_factory=PricingInfo)
    quota: QuotaSnapshot = field(default_factory=QuotaSnapshot)
    git: Dict[str, Any] = field(default_factory=dict)
    github: Dict[str, Any] = field(default_factory=dict)
    collectors: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    integrity: IntegrityInfo = field(default_factory=IntegrityInfo)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "collector_version": self.collector_version,
            "run_id": self.run_id,
            "work_package": self.work_package,
            "pr_number": self.pr_number,
            "agent": self.agent.to_dict() if isinstance(self.agent, AgentInfo) else self.agent,
            "timing": self.timing.to_dict() if isinstance(self.timing, TimingInfo) else self.timing,
            "usage": self.usage.to_dict() if isinstance(self.usage, UsageInfo) else self.usage,
            "pricing": self.pricing.to_dict() if isinstance(self.pricing, PricingInfo) else self.pricing,
            "quota": self.quota.to_dict() if isinstance(self.quota, QuotaSnapshot) else self.quota,
            "git": self.git,
            "github": self.github,
            "collectors": self.collectors,
            "warnings": self.warnings,
            "integrity": self.integrity.to_dict() if isinstance(self.integrity, IntegrityInfo) else self.integrity,
        }
