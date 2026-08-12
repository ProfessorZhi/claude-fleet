# Production Closure Tasks

- [x] Add authenticated Coordinator plan/tick session boundary.
- [x] Add automatic bounded WorkItem result correlation.
- [x] Add safe Claude/Codex process-level smoke fixtures without real API calls.
- [x] Add real/injected Git worktree provisioner and cleanup/recovery tests.
- [x] Add live-collector contracts for usage, duration, cost, and quota.
- [x] Add provider contracts for SCM/PR/CI and quality projection wiring.
- [x] Add authenticated quality recording/query and WorkItem-scoped cost metrics.
- [x] Add atomic snapshot recovery, schema version, and writer-lock tests.
- [x] Finish reusable Fleet sprite/effect fallback assets and manifest coverage.
- [x] Expand extension-host/CLI smoke and document environment-only gaps.
- [x] Synchronize architecture, roadmap, README, and release instructions.
- [x] Run full validation and package the final VSIX.

Runtime portion of the CLI smoke requirement is covered by
`server/__tests__/runtimeProcessSmoke.test.ts` and the deterministic fixtures
under `scripts/smoke/fixtures/`. Real CLI/API execution remains an explicit
environment-only test and is intentionally excluded from automated validation.
