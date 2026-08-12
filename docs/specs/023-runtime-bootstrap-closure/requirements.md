# Runtime Bootstrap Closure

## Purpose

Model the interactive bootstrap required by a Coding Agent runtime without
pretending that a terminal process is ready to receive work. Claude Code's
Workspace Trust prompt is a runtime-owned safety gate; Agent Fleet must surface
it and wait for evidence rather than bypassing it.

## Requirements

1. A launched terminal/process without SessionStart or transcript evidence is
   `RuntimeBootstrapState = starting` or `needs_user_interaction`, never an
   implicit runtime failure.
2. Bootstrap readiness is orthogonal to Connection, Execution, Task, and
   Attention state. The projection may show `Waiting User / Needs User` with a
   diagnostic reason such as `startup_interaction` or `workspace_trust`.
3. Launch defaults are `automationMode=interactive` and
   `permissionMode=default`. Permission flags are tool-permission controls and
   must not be treated as Workspace Trust bypasses.
4. WorkItem delivery has an authoritative lifecycle:
   `assigned → queued_for_runtime → delivering → delivered_to_runtime`, with
   terminal outcomes `failed` or `cancelled`.
5. A WorkItem assigned before runtime readiness remains queued. It is flushed
   exactly once after a ready evidence transition. Retrying a queued request
   does not duplicate it; stopping the instance cancels it.
6. Only the host's successful terminal write may produce
   `delivered_to_runtime`.
7. The UI action for bootstrap interaction focuses the owning Agent terminal;
   Fleet does not auto-accept trust or fabricate a permission dialog.

## Evidence boundary

For Claude Code, readiness is observed from the existing AgentState/session
signals (`hookDelivered` or transcript lines). A live terminal with no such
evidence is conservatively treated as waiting for startup interaction.
