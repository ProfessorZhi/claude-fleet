# Coordinator Workflow Requirements

## Goal

Provide a deterministic management-plane loop for one planning Coordinator to
create Mission/WorkItem records, assign a WorkItem to an existing managed
instance, and collect a bounded result summary without storing prompts,
transcripts, or raw runtime output.

## Requirements

- `assign_work_item` must require an explicit instance and an approve or
  autonomous control mode.
- Assignment must reject missing Missions, missing WorkItems, stopped/error
  instances, runtime/role policy mismatches, and incomplete dependencies.
- Repeating the same assignment to the same instance is idempotent.
- `collect_result` must accept only bounded metadata: outcome, optional summary,
  and optional artifact references.
- Result collection must update both the runtime-neutral WorkItem projection and
  the Ledger WorkItemRecord.
- Result collection must never persist raw prompt, transcript, environment,
  authorization, or Secret fields.
- A failed result maps to the existing `blocked` WorkItem status; the result
  keeps the precise outcome for the Coordinator.
