# Production Closure Design

```text
Coordinator Session API
        ↓ authenticated plan/tick
CoordinatorScheduler
        ↓ assign + bounded deliver
Runtime Host / Safe Fake CLI
        ↓ normalized FleetEvent / WorkItemResult
FleetControlService
   ├── Ledger + atomic snapshot persistence
   ├── Usage / quota / duration ingestion
   ├── Cost aggregation / WorkItem metrics projection
   ├── Quality evidence record/query boundary
   ├── Read-only SCM / PR / CI evidence
   └── Fleet Command projection
```

The implementation is split into independent boundaries:

- Coordinator session transport owns authentication, request idempotency, and
  explicit ticks; it does not spawn an unrestricted loop.
- Runtime smoke uses deterministic fake Claude/Codex executables and `--version`
  probes only. Real CLI execution remains opt-in and outside automated tests.
- Results are bounded metadata (`outcome`, `summary`, `artifactRefs`, timestamp,
  availability, confidence), not transcript transport.
- Git provisioning is injected so tests can use a fake git runner while a host
  can opt into real `git worktree` commands.
- `record_quality` accepts only bounded `QualitySignal` metadata. The
  read-only `/api/control/quality?workItemId=...` projection lets a
  Coordinator correlate PR/CI/review evidence with the same WorkItem used by
  usage metrics.
- `/api/control/metrics` can filter by `instanceId` and/or `workItemId`.
  Cost is aggregated only when all records use the same currency and billing
  basis; incompatible costs remain individual evidence.
- `/api/control/telemetry` is the authenticated ingestion boundary for
  agentmetrics/runtime Usage and quota envelopes. It preserves idempotency and
  rejects raw transcripts or secret-bearing fields before persistence.
- The VS Code adapter wires one bounded `codex-primary-session` into the
  embedded server. A native Codex JSONL session is adopted back onto the
  Fleet-launched instance so placeholder and native sessions cannot double
  count elapsed time.
- Persistence uses versioned snapshots and atomic replace semantics; malformed
  or conflicting snapshots fail closed.
- Canvas renders vessel state/assets; React/DOM renders engineering detail.
