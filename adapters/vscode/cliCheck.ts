/**
 * cliCheck — Spec 004 / Spec 005 Claude CLI availability check.
 *
 * Before we spawn a Claude Code terminal we verify the `claude` CLI is
 * actually invocable. Launching into a broken environment would create a
 * terminal that immediately fails, with no clear reason.
 *
 * The check runs ONCE per New Agent / Restart (never on a timer). It goes
 * through `resolveClaudeCli` (server/src/cliResolver.ts): PATH + npm global
 * bin probing, Windows claude.cmd/claude.exe support, no env mutation, and
 * a diagnostics block (PATH / searched paths / install hint) when missing.
 *
 * The executor is injectable so the check is unit-testable without spawning
 * real processes.
 */

import { resolveClaudeCli } from '../../server/src/cliResolver.js';

export type CliCheckResult =
  | { ok: true; version: string; command: string }
  | { ok: false; reason: string; diagnostics?: string };

/**
 * Check that the `claude` CLI can be resolved AND answers `--version`.
 * Returns `{ ok: true, version, command }` on success, or `{ ok: false,
 * reason, diagnostics }` on failure. `diagnostics` carries the resolver's
 * PATH / searched-path / install-hint block for the missing-CLI case.
 */
export async function ensureClaudeCliAvailable(): Promise<CliCheckResult> {
  const resolution = await resolveClaudeCli();
  if (!resolution.ok) {
    return {
      ok: false,
      reason: 'claude not found (PATH + npm global bin searched)',
      diagnostics: resolution.diagnostics,
    };
  }
  if (!resolution.version) {
    return { ok: false, reason: 'claude --version produced no output' };
  }
  return { ok: true, version: resolution.version, command: resolution.command };
}

/**
 * Build the user-facing message for the missing-CLI case. `diagnostics` is
 * the resolver's PATH / searched-paths / install-hint block (optional — the
 * fixed message alone is used when no diagnostics are available).
 */
export function claudeCliNotFoundMessage(diagnostics?: string): string {
  const base = 'Claude Fleet: Claude Code CLI not found.';
  if (diagnostics) {
    return `${base}\n\n${diagnostics}`;
  }
  return `${base} Please install Claude Code and ensure \`claude\` is available in PATH.`;
}

/** Fixed user-facing message when the CLI is unavailable (requirements FR-014). */
export const CLAUDE_CLI_NOT_FOUND_MESSAGE = claudeCliNotFoundMessage();
