# Design — Fleet Command Control Center

Fleet Command is a projection layer over the existing webview message/telemetry
projection. `App` owns transport, selection, and scene preference. Pure mapping code
builds a `FleetSceneModel`; presentational components render mission context, vessel
formation, instance detail, terminal dock, and timeline/recommendations.

The first implementation uses honest placeholders for mission/task/usage/PR data that
are not present in the current transport contract. This keeps the UI truthful while
leaving explicit seams for the Fleet Control API, Ledger, and Telemetry projections.
No component may create a runtime process directly. New Agent and management actions
continue through the existing extension transport.

The scene uses lightweight CSS/SVG-style vessel silhouettes rather than a bitmap
background. This preserves the logo-derived hard-surface sci-fi language while keeping
the webview responsive and testable. Pixel Office stays mounted only in its selected
scene branch and consumes the same `agents`/`agentStatuses` state.
