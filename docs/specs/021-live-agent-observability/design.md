# Design

## Configuration and discovery

`claudeConfigPath.ts` is the single path boundary. It resolves the active config
directory and returns the active/default/sibling profile roots for session scanning.
The installer writes the same Fleet hook into the active profile and existing
Claude profiles, so a terminal that inherits a different local profile still
emits events. Empty placeholder directories are not modified. The provider
continues to normalize raw Claude records before they reach the generic transcript
parser.

## Activity projection

The transcript parser preserves `toolName` on `agentToolStart`. The webview maps
that name and its status to a stable activity category. Claude `thinking` blocks
are represented as a short-lived synthetic `Thinking` activity, so the UI can
show reasoning without storing the thought content.

Canvas/overlay remains responsible for the compact activity label. The selected
DOM detail card receives the same derived activity string and remains the source
of readable runtime/usage information.

## Completion acknowledgement

`Character.completionUnread` is a client-only projection. A transition into a
non-input `waiting` state sets it. Clicking the character or opening its detail
clears it. The transient completion bubble remains independent, so a short visual
acknowledgement can still animate while the unread marker persists.
