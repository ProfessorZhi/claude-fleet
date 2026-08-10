# Configurable Scene Preference — Requirements

## Goal

Make the minimal task-control-center dashboard the product default. Keep Fleet
Command and Pixel Office as optional projections selected from Settings. The main
surfaces must stay focused on agent work rather than exposing a persistent scene
switcher.

## Requirements

1. A fresh webview opens in `control-center`.
2. A legacy persisted scene preference is migrated to the control center once; an
   explicit preference saved by the user remains stable afterwards.
3. Settings exposes two independent concepts:
   - current frontend: switch the projection immediately;
   - default frontend: persist which projection opens next time.
4. Selecting a default frontend also switches the current projection so the
   choice is immediately observable. Both values use the existing `SceneId`
   union and local storage only; they do not create a second runtime state.
5. Fleet Command and Pixel Office do not render a persistent scene-toggle
   control on their main surfaces. Scene switching is available from Settings.
6. Fleet vessel cards remain compact and stable in their formation. A single
   click selects a vessel and opens its detail projection. A double-click sends
   the existing focus command for that vessel's concrete terminal.
7. Fleet animation is presentation-only: it may move/animate a vessel without
   changing Agent ownership, lifecycle, terminal identity, or formation slot.
8. Settings controls and scene switching are covered by webview/E2E regression
   tests. Existing Pixel Office behavior tests explicitly opt into that scene.

## Non-goals

- No new Agent state store or runtime process model.
- No real Claude/Codex task is started by automated tests.
- No runtime image generation; the existing SVG/programmatic Fleet renderer is
  sufficient for this iteration.
