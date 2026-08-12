# Live Agent Observability

## Problem

Fleet can show the existence of a terminal, but a Claude Code process may use an
alternate `CLAUDE_CONFIG_DIR`. When Fleet installs hooks or scans only the default
directory, the terminal keeps working while Fleet stays at `Starting` and reports
no token usage.

## Requirements

1. Claude hook installation and session discovery MUST follow the active
   `CLAUDE_CONFIG_DIR` used by the extension process. Relative values are resolved
   relative to the user's home directory, matching Claude Code's convention.
2. Discovery SHOULD also inspect sibling `.claude-*` profiles so already-running
   terminals created with another local profile can be adopted without copying
   credentials or transcript contents.
3. The webview MUST expose the most specific currently active activity available:
   command line, reasoning, web research, MCP, plugin, multi-agent/subtask, file
   operation, permission, or waiting for input.
4. A completed turn MUST leave an unread completion indicator until the user opens
   that agent's detail view. The indicator MUST not be recreated by repeated
   status polling for the same waiting state.
5. Token and context values MUST remain observational and display `未采集` when
   the runtime has not emitted usage. No credentials, prompts, or transcript text
   may be persisted for this feature.

## Non-goals

- Starting real Claude/Codex work from tests.
- Treating a generated activity label as billing-grade telemetry.
- Replacing the existing Pixel Office renderer.
