/**
 * Spec 005 FR-008 — shell-aware launch command rendering.
 *
 * The integrated terminal shell differs per platform (cmd.exe / PowerShell
 * on Windows, sh/bash on POSIX) and a resolved CLI path may contain spaces
 * (e.g. `C:\Users\John Doe\AppData\Roaming\npm\claude.cmd`). No single
 * rendering is valid in every shell (see launchCommandRender.ts for the
 * verified behavior matrix), so the renderer picks the form by the detected
 * shell kind. These tests pin the per-shell contract.
 */

import { describe, expect, it } from 'vitest';

import { detectShellKind, renderLaunchCommand } from '../../adapters/vscode/launchCommandRender.js';

const ARGS = ['--session-id', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '--model', 'sonnet'];
const SPACE_PATH = 'C:\\Users\\John Doe\\AppData\\Roaming\\npm\\claude.cmd';

describe('detectShellKind', () => {
  it('maps Windows shell paths to their grammar family', () => {
    expect(detectShellKind('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(
      detectShellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'),
    ).toBe('powershell');
    expect(detectShellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe(
      'powershell',
    );
    expect(detectShellKind(undefined, 'win32')).toBe('powershell');
    expect(detectShellKind('/bin/bash', 'linux')).toBe('posix');
    expect(detectShellKind(undefined, 'darwin')).toBe('posix');
  });
});

describe('renderLaunchCommand', () => {
  it('passes bare commands through unchanged (all platforms and shells)', () => {
    expect(renderLaunchCommand('claude', ['--session-id', 'x'])).toBe('claude --session-id x');
    expect(
      renderLaunchCommand('claude', ['--session-id', 'x'], { platform: 'win32', shellKind: 'cmd' }),
    ).toBe('claude --session-id x');
    expect(
      renderLaunchCommand('claude', ['--session-id', 'x'], {
        platform: 'win32',
        shellKind: 'powershell',
      }),
    ).toBe('claude --session-id x');
  });

  it('renders a space-free Windows path bare (executes in cmd.exe and PowerShell)', () => {
    const bare = 'C:\\Users\\runner\\AppData\\Local\\Temp\\pixel-e2e-x\\bin\\claude.cmd';
    expect(renderLaunchCommand(bare, ARGS, { platform: 'win32', shellKind: 'powershell' })).toBe(
      `${bare} --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model sonnet`,
    );
    expect(renderLaunchCommand(bare, ARGS, { platform: 'win32', shellKind: 'cmd' })).toBe(
      `${bare} --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model sonnet`,
    );
  });

  it('uses the PowerShell call operator for a space-containing Windows path', () => {
    expect(
      renderLaunchCommand(SPACE_PATH, ARGS, { platform: 'win32', shellKind: 'powershell' }),
    ).toBe(`& "${SPACE_PATH}" --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model sonnet`);
  });

  it('quotes a space-containing Windows path for cmd.exe', () => {
    expect(renderLaunchCommand(SPACE_PATH, ARGS, { platform: 'win32', shellKind: 'cmd' })).toBe(
      `"${SPACE_PATH}" --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model sonnet`,
    );
  });

  it('quotes a space-containing path for POSIX shells', () => {
    expect(
      renderLaunchCommand('/Users/John Doe/.local/bin/claude', ARGS, {
        platform: 'darwin',
        shellKind: 'posix',
      }),
    ).toBe(
      '"/Users/John Doe/.local/bin/claude" --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model sonnet',
    );
  });
});
