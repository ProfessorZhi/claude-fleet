# Terminal-first runtime discovery

## Goal

Fleet must model a controllable terminal as an Agent/FleetInstance. A runtime
session is telemetry and conversation state belonging to that instance; it is
not, by itself, a terminal.

## Requirements

### R1 — Stable terminal identity

One Fleet-created Codex terminal MUST keep one Agent identity when Codex creates
or resumes another native session. A new session MUST update the terminal's
current session binding instead of creating a second Agent when the terminal
binding is unambiguous.

### R2 — Desktop session boundary

Codex Desktop sessions MUST NOT be auto-materialized as Worker Agents. They are
Coordinator/session activity and have no VS Code terminal that Fleet can focus
or stop.

### R3 — External CLI caution

A session file without a reliable terminal binding MUST NOT be presented as a
Fleet-managed terminal. External CLI session discovery may remain observable,
but it must not claim terminal control that the host cannot provide.

### R4 — Session-level telemetry

Filtering the Worker projection MUST NOT delete the underlying session evidence.
Token, duration, turn, and PR aggregation remain session-scoped and can later
be grouped under a terminal or Coordinator.

### R5 — Regression coverage

Tests MUST cover Desktop-session filtering and reuse of a single live managed
terminal beyond the initial launch-correlation window.
