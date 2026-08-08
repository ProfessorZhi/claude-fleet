/**
 * cliCheck — Spec 004 Claude CLI availability check.
 *
 * Before we spawn a Claude Code terminal we verify the `claude` CLI is
 * actually invocable. Launching into a broken environment would create a
 * terminal that immediately fails, with no clear reason.
 *
 * The check runs ONCE per New Agent / Restart (never on a timer — the CLI
 * binary doesn't appear/disappear every second). The executor is injectable
 * so the check is unit-testable without spawning real processes.
 */

import { execFile } from 'node:child_process';

export type CliCheckResult = { ok: true; version: string } | { ok: false; reason: string };

export type CliExecutor = (command: string, args: string[]) => Promise<string>;

/** Default executor: run `claude --version` and resolve with trimmed stdout. */
export function defaultCliExecutor(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve((stdout ?? '').trim());
    });
  });
}

/**
 * Check that `claude` is on PATH and responds to `--version`.
 *
 * Returns `{ ok: true, version }` on success, or `{ ok: false, reason }` on
 * any failure (missing binary, non-zero exit, timeout). `reason` is a
 * user-safe short string; callers surface the fixed user-facing message for
 * the missing-CLI case.
 */
export async function ensureClaudeCliAvailable(
  executor: CliExecutor = defaultCliExecutor,
): Promise<CliCheckResult> {
  try {
    const raw = await executor('claude', ['--version']);
    const version = raw.trim();
    if (!version) {
      return { ok: false, reason: 'claude --version produced no output' };
    }
    return { ok: true, version };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'claude not found in PATH' };
    }
    if (err?.code === 'ETIMEDOUT') {
      return { ok: false, reason: 'claude --version timed out' };
    }
    return { ok: false, reason: `claude --version failed: ${err?.message ?? String(e)}` };
  }
}

/** Fixed user-facing message when the CLI is unavailable (requirements FR-014). */
export const CLAUDE_CLI_NOT_FOUND_MESSAGE =
  'Claude Fleet: Claude Code CLI not found. Please install Claude Code and ensure `claude` is available in PATH.';
