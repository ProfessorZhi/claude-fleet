/**
 * Spec 005 — Claude Code CLI resolver tests.
 *
 * PATH scanning, npm global bin fallback, Windows claude.cmd/claude.exe
 * resolution, diagnostics on missing, no env mutation, no hardcoded
 * user-named paths.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeCandidateNames,
  defaultNpmBinCandidates,
  probeNpmGlobalBin,
  resolveClaudeCli,
} from '../src/cliResolver.js';

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-resolver-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeExecutable(rel: string, content = '#!/bin/sh\necho 2.1.220 (Claude Code)\n'): string {
  const full = path.join(tmpBase, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('claudeCandidateNames', () => {
  it('Windows tries claude.cmd / claude.exe / claude in order', () => {
    expect(claudeCandidateNames('win32')).toEqual(['claude.cmd', 'claude.exe', 'claude']);
  });

  it('POSIX uses plain claude', () => {
    expect(claudeCandidateNames('darwin')).toEqual(['claude']);
    expect(claudeCandidateNames('linux')).toEqual(['claude']);
  });
});

describe('resolveClaudeCli', () => {
  it('finds claude on PATH and returns its absolute path', async () => {
    const bin = writeExecutable('bin/claude');
    const resolution = await resolveClaudeCli({
      platform: 'linux',
      pathEnv: path.join(tmpBase, 'bin'),
      homeDir: tmpBase,
      verify: async (cmd) => {
        expect(cmd).toBe(bin);
        return '2.1.220 (Claude Code)';
      },
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.command).toBe(bin);
      expect(resolution.source).toBe('path');
      expect(resolution.version).toContain('2.1.220');
    }
  });

  it('finds claude via the npm global bin when PATH has nothing', async () => {
    const npmBin = writeExecutable('npm-global/claude');
    const resolution = await resolveClaudeCli({
      platform: 'linux',
      pathEnv: '',
      homeDir: tmpBase,
      verify: async () => '2.1.220',
      npmBinDir: async () => path.join(tmpBase, 'npm-global'),
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.command).toBe(npmBin);
      expect(resolution.source).toBe('npm-global');
    }
  });

  it('Windows resolves claude.cmd (explicit path, no PATHEXT reliance)', async () => {
    const cmdPath = writeExecutable('bin/claude.cmd', '@echo off\necho 2.1.220');
    const resolution = await resolveClaudeCli({
      platform: 'win32',
      pathEnv: path.join(tmpBase, 'bin'),
      homeDir: tmpBase,
      verify: async (cmd) => {
        expect(cmd).toBe(cmdPath);
        return '2.1.220';
      },
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.command).toBe(cmdPath);
    }
  });

  it('skips a broken candidate and finds a working one later', async () => {
    writeExecutable('broken/claude');
    const good = writeExecutable('good/claude');
    const calls: string[] = [];
    const resolution = await resolveClaudeCli({
      platform: 'linux',
      pathEnv: [path.join(tmpBase, 'broken'), path.join(tmpBase, 'good')].join(path.delimiter),
      homeDir: tmpBase,
      verify: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('broken')) throw new Error('broken install');
        return '2.1.220';
      },
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.command).toBe(good);
    }
    expect(calls[0]).toContain('broken');
  });

  it('missing CLI returns diagnostics with PATH, searched dirs and install hint', async () => {
    const resolution = await resolveClaudeCli({
      platform: 'linux',
      pathEnv: `${path.join(tmpBase, 'empty1')}${path.delimiter}${path.join(tmpBase, 'empty2')}`,
      homeDir: tmpBase,
      verify: async () => {
        throw new Error('not found');
      },
    });
    expect(resolution.ok).toBe(false);
    expect(resolution.source).toBe('not-found');
    expect(resolution.command).toBe('claude'); // safe fallback
    expect(resolution.diagnostics).toContain('Claude Code CLI not found');
    expect(resolution.diagnostics).toContain(path.join(tmpBase, 'empty1'));
    expect(resolution.diagnostics).toContain(path.join(tmpBase, 'empty2'));
    expect(resolution.diagnostics).toContain('npm install -g @anthropic-ai/claude-code');
    // Never mutate the environment.
    expect(process.env.PATH).not.toContain(tmpBase);
  });
});

describe('defaultNpmBinCandidates', () => {
  it('uses %APPDATA%\\npm on Windows (no hardcoded username)', () => {
    const appData = path.join(tmpBase, 'AppData', 'Roaming');
    expect(defaultNpmBinCandidates('win32', tmpBase, appData)).toEqual([
      path.join(appData, 'npm'),
      '/usr/local/bin',
      path.join(tmpBase, '.local', 'bin'),
    ]);
  });

  it('POSIX candidates come from home dir, never a fixed username', () => {
    const home = path.join(tmpBase, 'home', 'user-x');
    const candidates = defaultNpmBinCandidates('linux', home, undefined);
    expect(candidates).toContain('/usr/local/bin');
    expect(candidates).toContain(path.join(home, '.local', 'bin'));
    // No hardcoded third-party username like /home/<known-person>.
    expect(candidates.some((c) => /\/home\/[^/]+\/\.local/.test(c) && !c.startsWith(home))).toBe(
      false,
    );
  });
});

describe('probeNpmGlobalBin', () => {
  it('never throws and returns either undefined or an existing directory', async () => {
    const result = await probeNpmGlobalBin('linux', tmpBase, undefined);
    if (result !== undefined) {
      expect(fs.existsSync(result)).toBe(true);
    }
  });
});
