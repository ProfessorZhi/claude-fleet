# Runtime Choice for New Agent

## Goal

The Coordinator Session creates Worker Sessions. Each Worker is launched in its own VS Code terminal with an explicit runtime choice: Claude Code or Codex CLI.

## Requirements

1. The `New Agent` flow MUST ask for the runtime before collecting the Worker repo.
2. The Claude Code branch MUST preserve the existing Provider Profile, secret storage, model, session, and hook lifecycle.
3. The Codex CLI branch MUST check that the local `codex` executable is available and MUST launch without asking Fleet for an API key or storing a Codex credential.
4. The Codex CLI branch MUST use the user's existing local Codex login/session state; Fleet only records safe metadata such as runtime, repo, terminal, session identity, and status.
5. Every Worker MUST get an independent terminal, working directory, stable Fleet instance identity, and session identity. The Coordinator Session MUST NOT be represented as one of these Workers.
6. Focus and stop MUST target only the selected Worker terminal. A missing or closed Worker MUST NOT affect other Workers.
7. Runtime selection and Codex availability checks MUST be injectable in tests. Automated tests MUST NOT launch a real Claude or Codex task.
8. The Office projection MUST show the created Codex Worker with a safe runtime label, even when no Claude JSONL transcript is available.

## Non-goals

- Fleet does not implement Codex authentication.
- Fleet does not proxy Codex prompts or transcripts in this slice.
- Fleet does not make Codex the Coordinator automatically; the primary Codex client remains the planning/management Session.
