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
