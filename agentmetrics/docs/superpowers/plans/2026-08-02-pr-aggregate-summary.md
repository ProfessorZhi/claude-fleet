# PR Aggregate Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PR-level summary that aggregates multiple agent metrics runs for one pull request.

**Architecture:** Keep existing run summaries immutable and run-scoped. Add a small aggregate module that reads validated `sanitized-summary.json` files from storage, filters by PR number/repository, and emits a separate aggregate document without converting quota into token usage.

**Tech Stack:** Python standard library, existing `StorageManager`, existing CLI argparse, existing unittest suite.

---

### Task 1: PR Aggregator

**Files:**

- Create: `src/agent_metrics/pr_aggregate.py`
- Test: `tests/test_pr_aggregate.py`

- [ ] Add tests that write three sanitized summaries into a temp `StorageManager`: two token-bearing PR #4 runs and one Antigravity quota-only PR #4 run.
- [ ] Implement `build_pr_aggregate(storage, pr_number, repository=None)` that filters matching summaries, sums token buckets only from observed usage, sums calculated API-equivalent cost, records timing totals, and preserves quota-only Antigravity as unresolved usage.
- [ ] Run `python -m unittest tests.test_pr_aggregate`.

### Task 2: CLI Entrypoints

**Files:**

- Modify: `src/agent_metrics/cli.py`
- Test: `tests/test_pr_aggregate.py`

- [ ] Add `cmd_pr_summary(pr_number, repository=None, json_output=False, output_path=None)`.
- [ ] Add argparse subcommand `pr-summary --pr-number [--repository] [--json] [--output-path]`.
- [ ] Extend `export --format pr-aggregate --pr-number N --output-path file.json` without breaking existing run export.
- [ ] Run focused CLI tests.

### Task 3: Verification

**Files:**

- Modify: `README.md`

- [ ] Document PR aggregation as the correct way to report one PR across multiple goals/prompts.
- [ ] Run full test suite, compileall, secret scan, diff check.
- [ ] Commit and push ordinary commit.
