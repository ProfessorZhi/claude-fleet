# Agent Metrics Collector (`agent-metrics-collector`)

`agent-metrics-collector` is an independent, non-intrusive performance ledger and telemetry collector for AI Coding Agents. It measures Work Package and GitHub PR execution metrics without modifying your codebase, system proxies, or security credentials.

---

## 1. Problem Statement

AI Coding Agents often self-report execution metrics (model name, active duration, token consumption). Self-reported metrics are inherently unreliable due to:
- **Model Alias Mismatch**: Agents reporting requested or configured models rather than the observed runtime model executing on remote provider infrastructure.
- **Wall Clock vs Active Time Inflation**: Agents estimating active working duration based on wall clock time without accounting for user thinking time or CI build delays.
- **Hallucinated Token Usage**: Estimating tokens from text character counts or quota percentage drops.

`agent-metrics-collector` acts as an external observer, capturing verifiable runtime facts and calculating equivalent API costs.

---

## 2. Architecture & Workflow

```text
[ AI Coding Agent ]
        │
        ▼ (Calls CLI: start / finish / reconcile)
[ Agent Metrics Collector CLI ]
        │
  ┌─────┴─────────────────────────────┐
  ▼                                   ▼
[ Local Collectors ]         [ External Integrations ]
- Git Collector              - GitHub CLI (gh)
- Claude Code Collector      - Cockpit CLIProxy
- Cockpit Quota Collector    - Antigravity Telemetry Logs
- Pricing Engine
  │
  ▼
[ Sanitized Summary (.local/runs/<RUN_ID>/sanitized-summary.json) ]
  │
  ├───────────────────────────────┐
  ▼                               ▼
[ Zuno PR Record Fragment ]   [ ChatGPT Performance Auditor ]
```

---

## 3. Data Ownership & Responsibilities

| Entity | Role & Responsibilities |
| :--- | :--- |
| **Agent** | Executes subcommands (`start`, `finish`, `reconcile`, `export`). Does not self-report token numbers. |
| **Collector** | Records empirical, observable facts (Git SHAs, timing, CLIProxy usage events, structured session logs). |
| **GitHub** | Source of truth for remote PR state, commit count, and CI build duration. |
| **ChatGPT Auditor** | Evaluates performance metrics, PR records, and quality scores. |

---

## 4. Quick Start

### PowerShell Launcher Usage

#### Claude Code (Default)
```powershell
.\agent-metrics.ps1 start `
  --agent-shell "Claude-Code" `
  --provider "Anthropic" `
  --configured-model "claude-3-5-sonnet-20241022" `
  --work-package "DS-PHASE22-RUNTIME-EVIDENCE" `
  --pr-number 60 `
  --worktree "F:\internship-work\Zuno-worktrees\example"
```

#### DeepSeek / MiniMax via Claude Code
```powershell
.\agent-metrics.ps1 start `
  --agent-shell "Claude-Code" `
  --provider "DeepSeek" `
  --configured-model "deepseek-v4-flash" `
  --work-package "DS-PHASE22-RUNTIME-EVIDENCE" `
  --pr-number 60
```

#### Antigravity
```powershell
.\agent-metrics.ps1 start `
  --agent-shell "Antigravity" `
  --provider "Google" `
  --configured-model "gemini-3.6-flash" `
  --work-package "AG-PR56-EXAMPLE" `
  --pr-number 56
```

#### Finishing a Run
```powershell
.\agent-metrics.ps1 finish --run-id "<RUN_ID>"
```

#### Reconciling GitHub PR & CI Status
```powershell
.\agent-metrics.ps1 reconcile `
  --run-id "<RUN_ID>" `
  --repository "ProfessorZhi/Zuno" `
  --pr-number 56
```

#### Exporting Zuno PR Record Fragment
```powershell
.\agent-metrics.ps1 export `
  --run-id "<RUN_ID>" `
  --format zuno-pr-record-fragment `
  --output "F:\temp\metrics-fragment.json"
```

---

## 5. Cockpit Tools Integration

> [!IMPORTANT]
> - **Quota Snapshot $\neq$ Request Usage**: Cockpit quota percentages or balance changes do **NOT** equal token usage.
> - **CLIProxy Telemetry**: Token breakdowns are only captured if Antigravity / Agent traffic passes through the local Cockpit `CLIProxy`.
> - **No Routing Modification**: `agent-metrics-collector` does **not** automatically modify system proxies, hosts files, or Antigravity routing configuration.
> - Run `.\agent-metrics.ps1 doctor` to verify Cockpit detection.

### Codex Quota Quick Start

The Codex Quota collector is a small, fail-closed, read-only module that
captures sanitized Before / After quota snapshots from a local Cockpit Tools
(or compatible) Codex quota endpoint.

#### Doctor

```powershell
.\agent-metrics.ps1 doctor --json
```

Inspect the `codex_quota` field. Possible states:
- `AVAILABLE` — A Codex quota source responded. Snapshot capture will be
  attempted on `start` / `finish`.
- `CONFIG_REQUIRED` — `COCKPIT_BASE_URL` is set but the endpoint did not
  respond. Configure or restart Cockpit and re-check.
- `NOT_AVAILABLE` — No Codex quota source could be discovered on this host.

#### Runner

```powershell
.\scripts\run-codex-with-metrics.ps1 `
  -WorkPackage "ZUNO-WP-001" `
  -Repository "ProfessorZhi/Zuno" `
  -Worktree "F:\funny_project\zuno-worktrees\wp-001" `
  -- "只回复 OK，不修改任何文件。"
```

The runner wraps `agent-metrics start` → `codex exec --json` → `finish`.
It stores the raw JSONL stream in a run-private temporary directory, parses
usage buckets, then removes the raw stream after `finish`. It propagates the
original Codex exit code and always invokes `finish`, even when Codex fails.
The collector binds the observed `thread_id` as the run's native agent session
and deduplicates usage by `thread_id + turn identity`; if one private stream
contains multiple threads without an explicit binding, usage is `AMBIGUOUS`.

Stable stdout lines:

```text
RUN_ID=
SUMMARY_PATH=
AGENT_EXIT_CODE=
```

Request usage comes only from structured `codex exec --json` events:
`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
`output_tokens`, and `reasoning_output_tokens`. Quota percentage deltas are
never converted into tokens or cost.

### Claude Code Provider Presets

```powershell
.\scripts\run-claude-with-metrics.ps1 `
  -Provider DeepSeek `
  -ConfiguredModel "deepseek-chat" `
  -WorkPackage "ZUNO-WP-002" `
  -Repository "ProfessorZhi/Zuno" `
  -Worktree "F:\funny_project\zuno-worktrees\wp-002" `
  -- <Claude Code args>
```

`-Provider DeepSeek` defaults to `.claude-deepseek`; `-Provider MiniMax`
defaults to `.claude-minimax`. The full config path is not written to summary
output; only logical names such as `deepseek`, `minimax`, or `custom` may be
reported.

The Claude runner records a session baseline, starts Claude Code as a child
process, watches for exactly one new or growing JSONL transcript, reads the
native `sessionId`, and calls:

```powershell
agent-metrics bind-session `
  --run-id "<RUN_ID>" `
  --agent-session-id "<CLAUDE_SESSION_ID>" `
  --agent-process-id <PID> `
  --binding-source new_jsonl_after_process_start
```

When multiple candidate transcripts change, the runner does not choose the
newest file. It leaves usage attribution `AMBIGUOUS`, while still executing
`finish` and preserving the original Claude exit code.

Each run is a session segment. For reused Claude sessions, `start` records a
safe cursor and `finish` only counts JSONL bytes after that cursor, with
message-id hash deduplication as a second guard against replayed events.

#### Summary Location

Each run writes `.local/runs/<RUN_ID>/sanitized-summary.json` plus a
`.sha256` sidecar. The runner prints `SUMMARY_PATH=` on stdout.

#### Quota Status Semantics

| Status | Meaning |
| :--- | :--- |
| `COMPLETE` | Before and After captured; Delta computed. |
| `NOT_AVAILABLE` | No Cockpit source discovered. Run still completed. |
| `AMBIGUOUS` | Multiple accounts visible and ownership cannot be proven. Delta is `null`. |
| `RESET_DURING_RUN` | A quota window reset while the run was active. Per-window Delta is `null`. |
| `SEMANTICS_UNVERIFIED` | The percentage field semantics (`remaining` vs `used`) could not be proven. Delta is `null`. |

#### Percentage Semantics

When Cockpit clearly documents whether the percentage means
`remaining` or `used`, the collector computes Delta accordingly. When the
semantics cannot be proven, the snapshot is recorded with `percentage_semantics
= "unknown"` and Delta is not calculated.

#### Important Caveats

- **Quota Percentage $\neq$ Token Counts.** A drop in percentage cannot be
  converted to tokens or USD.
- **Delta $\neq$ Actual Billing Cost.** No pricing data is consulted.
- **Balance / Quota $\neq$ Request Usage.** DeepSeek balance, MiniMax token
  plan remains, and Cockpit quota snapshots are separate metadata sources.
- **Quota Scope is Account.** Quota snapshots are account context. They are
  not allocated to a session unless the run proves an exclusive session window;
  concurrent sessions report `AMBIGUOUS_CONCURRENT_SESSIONS`.
- **This Round Did Not Validate Real Codex Requests.** End-to-end Codex
  network calls were intentionally skipped — the Runner is exercised with a
  fake Codex process.
- **Request-Level Token Collection May Still Be `NOT_AVAILABLE`.** Use of
  CLIProxy request-level telemetry is out of scope for this round.
- **Cockpit Unavailability Does Not Block Ordinary Runs.** A `start` /
  `finish` cycle succeeds even when the Codex quota source is unreachable.
- **Not Production Ready.** This tool is not declared production-ready.

---

## 6. Privacy & Redaction Policy

`agent-metrics-collector` enforces a **Zero-Exposure Policy**:
- **NEVER Saved**: Prompts, assistant response text, source code text, OAuth tokens, API keys (`sk-...`, `GOCSPX-...`), Authorization headers, Cookies, user email addresses, or home directory paths.
- **Sanitization**: All output JSON objects pass through a centralized redaction engine replacing secrets with `[REDACTED]` and recording warnings in `sanitized-summary.json`.

---

## 7. Confidence Semantics

| Level / Status | Meaning |
| :--- | :--- |
| `OBSERVED` | Model or usage verified directly from provider response or CLIProxy event. |
| `REQUESTED` | Model name extracted from outgoing API request header/payload. |
| `CONFIGURED` | Model name retrieved from local configuration files. |
| `INFERRED` | Model inferred based on provider defaults or heuristics. |
| `QUOTA_ONLY` | Only quota balance delta was available; tokens remain `null`. |
| `EXACT_SESSION_AND_CURSOR` | Native session ID and segment cursor matched; request usage may be `COMPLETE`. |
| `EXACT_SESSION` | Session matched strictly by explicit session UUID. |
| `EXACT_WORKTREE` | Session matched strictly by worktree directory path. |
| `EXACT_WORK_PACKAGE` | Session matched strictly by work package identifier. |
| `TIME_WINDOW_MATCH` | Session matched by overlapping execution timeframe. |
| `AMBIGUOUS` | Multiple candidates matched; fail-closed without guessing. |
| `NOT_AVAILABLE` | No telemetry or session matching available. |

---

## 8. Limitations & Guidelines for Updating Model Pricing

- **Claude Code Transcript Format**: Local session formats may change across CLI updates.
- **Quota Delta**: Quota percentage drop cannot be converted into token numbers.
- **API Equivalent Cost**: Represents standard provider list price (`api_equivalent_cost_usd`), not actual billed cost (`actual_billed_cost_usd = null`).
- **Cockpit Measurement**: Blocked / NOT_AVAILABLE.
- **Antigravity Measurement**: Blocked / NOT_AVAILABLE.
- **Pricing**: Unverified.
- **Production Readiness**: Not Production Ready.

### Updating Model Pricing Snapshot

Official provider pricing is maintained in [`config/model-pricing.json`](file:///F:/funny_project/agent-metrics-collector/config/model-pricing.json). To update:
1. Verify prices from official provider pricing pages (e.g. `https://www.anthropic.com/pricing`, `https://platform.deepseek.com/pricing`).
2. Update rates in `config/model-pricing.json`.
3. Set `"verification_status": "VERIFIED"`, `"retrieved_at"`, and `"source_url"`.

---

## 9. Exit Codes

All CLI entrypoints (`python -m agent_metrics`, installed `agent-metrics` console script, and `agent-metrics.ps1`) propagate identical, deterministic process exit codes:

| Code | Symbol | Meaning |
| :---: | :--- | :--- |
| `0` | `EXIT_OK` | Complete Success |
| `2` | `EXIT_PARTIAL` | Partial Success / Optional Dependency Unavailable (e.g., Doctor with optional collectors NOT_AVAILABLE) |
| `4` | `EXIT_INVALID_INPUT` | Invalid Input Parameters or Malformed Run ID |
| `5` | `EXIT_STORAGE_ERROR` | Storage IO / File Not Found Failure |
| `6` | `EXIT_INTEGRITY_ERROR` | SHA-256 Payload Hash Mismatch or Corrupted Sidecar |
| `7` | `EXIT_EXTERNAL_CMD_ERROR` | External Command (e.g. `gh` CLI) Failure |

---

## 10. Claude Baseline Privacy Policy

The Claude Session Baseline collector minimal privacy policy guarantees:
- **Preserved Metadata**: Logical Config Name (`default`, `deepseek`, `minimax`, `custom`), Session ID (UUID), File Size, and Last Modified Timestamp.
- **NEVER Saved in Baseline**: Claude Config directory paths, Project directory paths, JSONL file paths, Worktree paths, or Home username.

## 11. Timing Semantics

`timing` separates:
- `wall_clock_seconds`: `start` to `finish`.
- `agent_process_seconds`: wrapper-observed child process duration.
- `model_event_span_seconds`: first structured model event to last structured
  model event.
- `ci_queue_seconds`: GitHub workflow `created_at` to `run_started_at`.
- `ci_run_seconds`: GitHub workflow `run_started_at` to `completed_at`.
- `agent_active_seconds`: `null` unless explicit active telemetry exists.
