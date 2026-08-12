# Spec 010 — Fleet Scene Visual System

## Goal

Define a maintainable visual system for Fleet Command. Runtime state maps to a
composable visual state; stable role-based vessel identity is separate from runtime,
status effects, selection, and transient events. Concept art may inform the visual
language but is not a runtime animation dependency.

## Requirements

- Base vessel identity MUST remain stable across status changes.
- Role MUST determine vessel type: coordinator → flagship, worker/debugger → frigate,
  reviewer/researcher → recon, subagent → drone.
- Runtime MUST be a small badge/metadata layer and MUST NOT determine vessel type.
- Persistent FleetStatus MUST map to composable engine, beacon, and motion effects.
- `task_finished`, `tool_started`, and subagent events MUST remain transient event
  inputs; they MUST NOT become long-lived status combinations.
- Selected state MUST be an orthogonal visual flag with a larger accessible hit target.
- The initial asset implementation MAY be deterministic SVG/CSS greybox/fallback; the
  asset boundary MUST allow later base/engine/effect sprite sheets without changing
  FleetInstance or the Scene Model.
- High-frequency animation MUST not require React state updates per frame.
- Canvas/world rendering and DOM/developer information MUST remain separate concerns.
- Pixel Office and Fleet Command MUST continue to consume the same Scene Model inputs.
