# Billing Observability Tasks

- [x] Add explicit token/API/metered/subscription/quota-impact contracts.
- [x] Aggregate each cost basis and quota impact by WorkItem with usageId dedupe.
- [x] Extend telemetry normalization and HTTP boundary for the new fields.
- [x] Add agentmetrics subscription catalog, local price override, and quota delta projection.
- [ ] Add Codex/MiniMax plan-type and quota snapshot adapters without secret persistence.
- [x] Add tests for multi-turn session aggregation, cumulative snapshot dedupe, and custom prices.
- [ ] Update Fleet Command detail/metrics projection and release documentation.
