# Design — Fleet Scene Visual System

```text
FleetInstance
  → FleetSceneModel
  → VesselVisualState
  → VesselAssetSet / deterministic fallback
  → Animation controller
  → scene renderer
```

`visualState.ts` is a pure mapper. It returns `vesselType`, runtime badge, engine,
beacon, motion, selection, and completion pulse. `VesselSprite` consumes this model
and currently renders a logo-derived SVG hull plus CSS effects. A future sprite
manifest can replace the SVG body/effect layers while keeping the props and mapper.

The first four asset targets are flagship, frigate, recon, and drone. The current
fallback uses no generated bitmap assets so it is deterministic, accessible, and safe
for tests. Sprite dimensions, palette, and asset manifests can be added after greybox
interaction is stable.
