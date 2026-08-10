# Production Closure Requirements

## Goal

Close the remaining gaps between the current bounded control-plane Alpha and the
intended local-first Agent Fleet workflow: one Coordinator session manages many
Claude/Codex terminal workers, receives bounded results, records usage, isolates
worktrees, survives restart, and presents the Fleet Command projection.

## Requirements

1. A Coordinator session can expose an explicit, authenticated plan/tick control
   boundary without becoming an unrestricted background daemon.
2. A delivered WorkItem can produce a bounded, secret-free result envelope that
   is automatically correlated back to the WorkItem and Instance.
3. Claude and Codex runtime adapters have safe no-API smoke coverage for launch,
   focus, task delivery, event/result flow, stop, restart, and resume semantics.
4. Worktree provisioning has a real injected git implementation with conflict,
   cleanup, and recovery coverage; metadata-only mode remains available.
5. Usage, duration, cost, and quota collectors can be connected to the control
   plane with explicit unavailable semantics and no fabricated values.
6. A Coordinator can record and query secret-free SCM/PR/CI quality signals by
   WorkItem, and retrieve compatible per-WorkItem cost/time/token totals.
7. SCM/PR/CI integrations have provider contracts and safe read-only adapters;
   no write operation or raw diff/secret may cross the ledger boundary.
8. Snapshot persistence has restart recovery, atomic writes, schema/version
   handling, and concurrent-writer protection.
9. Scene preference is stable and configurable (current validation default is
   Pixel Office; Fleet Command remains a first-class option) and reusable Fleet
   assets do not move engineering metadata into Canvas.
10. The test suite covers mixed-runtime contracts, extension-host smoke, safe
    CLI probes, and documents any environment-only tests that cannot run.
11. Roadmap, architecture, README, and spec task state match the shipped
    behavior and explicitly identify remaining external-provider boundaries.

## Safety constraints

- Never start a real Claude/Codex task or send a real task prompt during tests.
- Never persist raw prompt, transcript, API key, token, or full diff content.
- All side effects remain policy-controlled and auditable.
- Existing user changes and Git history must be preserved.
