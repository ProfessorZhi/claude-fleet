# Claude-owned Runtime Spike

## Purpose

Validate the smallest runtime boundary that gives Fleet reliable programmatic
stdin/stdout ownership while keeping the worker visible in the selected VS Code
window. This is an experimental spike; the existing integrated-terminal launch
path remains the default until the spike is proven with a real Claude session.

## Problem

`vscode.Terminal.sendText()` is a display-terminal convenience API. It does not
give Fleet ownership of the runtime's input/output stream, and the current
production path has no safe direct `sendText` diagnostic boundary. This makes it
impossible to distinguish a PTY submission problem from a Claude/session
problem without creating a formal WorkItem.

## Scope

The spike MUST:

1. Own a spawned Claude process inside the VS Code Extension Host.
2. Keep the process associated with `externalInstanceId`, `sessionId`, and a
   Fleet-created terminal identity.
3. Mirror stdout and stderr into a VS Code `Pseudoterminal` so the user can
   inspect the same runtime in the selected VS Code window.
4. Forward human terminal input from the Pseudoterminal to the process stdin.
5. Expose an explicit programmatic write boundary with separate raw-write and
   prompt-submit semantics.
6. Support focus, stop, process-exit observation, and disposal.
7. Never log or expose provider secrets.
8. Remain opt-in and must not change the existing `vscode.Terminal` launch
   behavior in this spike.

## Non-goals

- Replacing the current production launch path.
- Reimplementing Claude Code's TUI, session protocol, hooks, or transcript
  parser.
- Inferring Fleet state from terminal display text.
- Adding a new WorkItem or Mission transport contract.
- Solving result collection, unread completion, billing, or UI layout.

## Acceptance criteria

- A fake child process test proves bytes written through the Fleet-owned input
  boundary arrive exactly once at stdin, with submission newline explicit.
- A fake child process test proves stdout/stderr are mirrored to the VS Code
  Pseudoterminal.
- Focus resolves the correct owned terminal by `externalInstanceId`.
- Stop kills and disposes only the selected owned runtime.
- Process exit removes the owned runtime and exposes the exit code.
- Existing production tests continue to use `vscode.Terminal.sendText` and are
  unchanged by this spike.

## Follow-up gate

Only after a real Claude session proves that the owned stream receives a human
prompt, produces the expected JSONL/Hook evidence, and survives Workspace Trust
and restart should the production launch path be switched behind an explicit
transport setting.
