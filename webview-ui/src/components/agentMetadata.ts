/**
 * Pure helpers for the Spec 002 Agent Metadata section in DebugView.
 *
 * Extracted from DebugView.tsx so the logic is unit-testable without
 * pulling in React Testing Library / jsdom (which aren't currently
 * installed in this project).
 *
 * All helpers are deliberately pure: they take inputs and return strings.
 */

export function basename(path: string): string {
  // Tolerate both / and \ separators (Windows / POSIX). The project's
  // projectDir comes from VS Code / Claude Code, so it may contain either.
  // Drop empty pieces so trailing/leading separators don't yield "".
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * Shorten a Claude Code session id for display.
 *
 * Claude Code's transcript path is `<sessionId>.jsonl`; we strip the
 * extension and show the first 8 characters — enough to identify the
 * session in logs without flooding the UI.
 */
export function shortSessionId(jsonlFile: string): string {
  if (!jsonlFile) return '—';
  const base = basename(jsonlFile);
  return base.replace(/\.jsonl$/, '').slice(0, 8) || '—';
}

/**
 * Map an AgentState.status (from the webview) to a short user-facing label.
 *
 * The webview tracks status as one of: `running` / `waiting` / `idle` / `error`
 * / `stopped` (per AgentState types). This helper renders those into the
 * visible Debug View row.
 *
 * `waitingForInput` overrides any other label — when the underlying character
 * is in the "waiting for input" sub-state, we surface that explicitly.
 */
export function statusLabel(status: string | undefined, waitingForInput: boolean): string {
  if (waitingForInput) return 'Waiting for input';
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting';
    case 'idle':
      return 'Idle';
    case 'error':
      return 'Error';
    case 'stopped':
      return 'Stopped';
    case 'starting':
      return 'Starting';
    default:
      return status ?? 'Idle';
  }
}
