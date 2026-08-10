# Configurable Scene Preference — Design

`App` remains the owner of the selected scene. `scene.ts` owns serialization
and migration for both the current and default scene values. `SettingsModal`
receives the two values and callbacks, and therefore remains a projection
control rather than a state source.

```text
localStorage
  ├─ claude-fleet.visual-scene          current projection
  ├─ claude-fleet.default-scene         next-open projection
  └─ claude-fleet.visual-scene-version  migration gate
                    ↓
                  App
          ┌─────────┴─────────┐
          ↓                   ↓
     Fleet Command       Pixel Office
```

The Fleet scene uses a compact DOM hit target for each vessel, while the Canvas
formation and SVG layers provide the animated world. `onClick` only changes
the selected projection. `onDoubleClick` calls the existing focus callback;
the callback is responsible for sending the existing `focusAgent` message.
The CSS flight motion is deliberately small and disabled under
`prefers-reduced-motion`.

The settings controls carry stable test IDs so Playwright can exercise scene
switching without relying on visible copy or toolbar layout.
