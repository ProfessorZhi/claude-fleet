# Spec 009 — Fleet Command Control Center

## Goal

Make Fleet Command a real Agent Fleet control center, not a Pixel Office reskin. The
default scene must provide a global mission view, a selectable instance detail view,
and a terminal dock that leads to the real VS Code terminal only when intervention is
needed. Pixel Office remains available as a projection of the same state.

## Requirements

### R1 — Shared fleet state

Fleet Command and Pixel Office MUST consume the existing agent, status, tool,
telemetry, and transport projections. The webview MUST NOT introduce a second source
of truth for FleetInstance state.

### R2 — Mission/coordinator context

Fleet Command MUST show the current mission context, coordinator identity (when
available), active/working/waiting counts, task progress, and resource/usage summary.
Missing upstream data MUST render a neutral placeholder rather than fabricated facts.

### R3 — Vessel scene

Each Fleet instance MUST have a stable vessel identity. Role maps to vessel class:
coordinator/flagship, worker/frigate, reviewer/recon, debugger/engineering,
subagent/drone, external/unknown. Status changes MUST affect status indicators and
animation/lighting without changing the identity.

### R4 — Instance detail

Selecting a vessel MUST update an instance detail panel with runtime, role, status,
repo, worktree/cwd, provider/model, session, task/tool, context/usage, and recent
telemetry when available. Actions MUST use existing focus/restart/provider-switch/
stop transport commands.

### R5 — Terminal dock

Fleet Command MUST expose a compact terminal dock for active instances and a New Agent
entry point. Selecting an instance and focusing its terminal MUST remain distinct
actions.

### R6 — Timeline/recommendations

The scene MUST provide an event/timeline area and a recommendation area. They MUST
clearly distinguish live telemetry from unavailable/planned data and MUST NOT start a
real runtime task as part of rendering or tests.

### R7 — Brand language and readability

The visual language MUST derive from the Agent Fleet logo direction: deep navy/black
space, electric cyan, restrained violet, metallic vessels, and amber/red status
signals. Sci-fi treatment belongs primarily to the scene and vessel/status layer;
details remain legible developer UI.

### R8 — Backward compatibility

Pixel Office MUST remain selectable and its existing editor, hooks, pets, and agent
behavior tests MUST continue to work.

### R9 — Validation

Add deterministic webview tests for model/scene rendering and VS Code E2E coverage for
Fleet Command default display, instance creation, selection, scene switching, and
terminal-dock controls. Existing server and package-contract tests MUST remain green.
