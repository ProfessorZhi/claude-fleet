/**
 * Spec 004 — tests for the Claude CLI availability check.
 *
 * The executor is injected, so no real `claude` process is ever spawned.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  ensureClaudeCliAvailable,
} from '../../adapters/vscode/cliCheck.js';

function okExecutor(
  version = '2.1.0 (Claude Code)\n',
): (cmd: string, args: string[]) => Promise<string> {
  return async (cmd, args) => {
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--version']);
    return version;
  };
}

describe('ensureClaudeCliAvailable — Spec 004', () => {
  it('returns ok with version when claude responds', async () => {
    const result = await ensureClaudeCliAvailable(okExecutor('2.1.0'));
    expect(result).toEqual({ ok: true, version: '2.1.0' });
  });

  it('rejects ENOENT (binary not on PATH)', async () => {
    const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const result = await ensureClaudeCliAvailable(async () => {
      throw err;
    });
    expect(result).toEqual({ ok: false, reason: 'claude not found in PATH' });
  });

  it('rejects non-zero exit (broken install)', async () => {
    const result = await ensureClaudeCliAvailable(async () => {
      throw new Error('Command failed: claude --version (exit 127)');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('failed');
    }
  });

  it('rejects empty output', async () => {
    const result = await ensureClaudeCliAvailable(okExecutor('   \n'));
    expect(result.ok).toBe(false);
  });

  it('reports timeout via ETIMEDOUT', async () => {
    const err = new Error('timed out') as NodeJS.ErrnoException;
    err.code = 'ETIMEDOUT';
    const result = await ensureClaudeCliAvailable(async () => {
      throw err;
    });
    expect(result).toEqual({ ok: false, reason: 'claude --version timed out' });
  });

  it('exposes the fixed user-facing message for the missing-CLI case', () => {
    expect(CLAUDE_CLI_NOT_FOUND_MESSAGE).toContain('Claude Code CLI not found');
  });
});
