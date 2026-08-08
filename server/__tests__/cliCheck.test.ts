/**
 * Spec 004 / Spec 005 — Claude CLI availability check surface.
 *
 * The actual resolution (PATH scan / npm global bin / Windows candidates /
 * diagnostics) is unit-tested in cliResolver.test.ts; this file covers the
 * user-facing message builders and the result shape.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  claudeCliNotFoundMessage,
} from '../../adapters/vscode/cliCheck.js';

describe('claudeCliNotFoundMessage — Spec 005', () => {
  it('exposes the fixed user-facing message for the missing-CLI case', () => {
    expect(CLAUDE_CLI_NOT_FOUND_MESSAGE).toContain('Claude Code CLI not found');
    expect(CLAUDE_CLI_NOT_FOUND_MESSAGE).toContain('PATH');
  });

  it('appends resolver diagnostics when available (PATH + searched dirs + install hint)', () => {
    const diagnostics = [
      'Claude Code CLI not found.',
      '',
      'Searched candidates: claude',
      '',
      'Current PATH:',
      '    - /usr/bin',
      '',
      'Searched directories (PATH + npm global bin):',
      '    - /usr/bin',
      '    - /usr/local/bin',
      '',
      'Install: npm install -g @anthropic-ai/claude-code',
    ].join('\n');
    const msg = claudeCliNotFoundMessage(diagnostics);
    expect(msg).toContain('Claude Code CLI not found');
    expect(msg).toContain('/usr/bin');
    expect(msg).toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('falls back to the plain message when no diagnostics are provided', () => {
    const msg = claudeCliNotFoundMessage();
    expect(msg).toContain('Claude Code CLI not found');
    expect(msg).toContain('available in PATH');
  });
});
