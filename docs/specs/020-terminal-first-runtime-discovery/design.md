# Design

## Identity boundary

```text
VS Code terminal / FleetInstance
  └── current Codex session
        └── turns / token snapshots / PR evidence
```

The Codex JSONL scanner remains a session reader. It uses the native metadata
`originator` to exclude `Codex Desktop` threads from the Worker projection.
Fleet-created terminals are matched by the existing placeholder adoption path;
when there is exactly one live managed Codex terminal for a workspace, that
terminal remains the owner of later sessions even after the five-minute launch
correlation window. If several terminals share the same workspace, the older
time-based match remains the safe fallback and ambiguous sessions are not
guessed.

## Non-goals

- Do not infer an arbitrary user's terminal from a JSONL file and cwd alone.
- Do not merge unrelated Codex Desktop threads into one fake terminal.
- Do not delete session files or usage evidence.

## Compatibility

Session records without an `originator` remain discoverable for backward
compatibility and for older Codex CLI versions. Only an explicit
`originator: "Codex Desktop"` is filtered.
