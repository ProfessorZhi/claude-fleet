# Coordinator Workflow Design

`FleetControlService` remains the execution boundary. The new actions are
management operations, not a scheduler and not a runtime transcript transport.

```text
Coordinator
  -> create_mission
  -> create_work_item
  -> recommend_assignment
  -> assign_work_item
  -> collect_result
```

`assign_work_item` binds one WorkItem to one existing FleetInstance and updates
the shared projection. Runtime-specific input delivery remains an adapter
concern and is intentionally not inferred by this feature.

`collect_result` stores a `WorkItemResult` with bounded metadata and maps its
outcome to the existing WorkItem lifecycle. A later SCM/quality adapter can
attach commit, PR, CI, and review evidence without changing this boundary.

`record_telemetry` accepts normalized `UsageRecord` and `QuotaSnapshot`
projections from an observability adapter such as agentmetrics. It records only
the normalized metadata; it does not accept raw runtime events or transcripts.
