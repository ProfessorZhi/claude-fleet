/**
 * Spec 005 FR-008 — subprocess-level regression tests for Windows .cmd
 * execution in cliResolver.
 *
 * These cover the original bug: the default verifier called execFile on a
 * `.cmd` candidate directly, which throws `spawn EINVAL` on Windows, so a
 * claude.cmd-only install (mock or real) could never be resolved and every
 * launch aborted with "CLI not found". Injected `verify` fakes in the other
 * resolver tests cannot catch this — these run real subprocesses.
 *
 * The `runIf(process.platform === 'win32')` tests execute only on Windows;
 * on Linux CI they are skipped (cmd.exe does not exist). The string-level
 * tests (cmd-line construction, native executable capture) run everywhere.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCmdScriptCmdLine,
  execCaptured,
  probeNpmGlobalBin,
  resolveClaudeCli,
} from '../src/cliResolver.js';

const WORKING_CMD = '@echo off\r\necho 2.1.220-mock (Claude Code)\r\n';
const BROKEN_CMD = '@echo off\r\nexit /b 1\r\n';

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-win-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeClaudeCmd(dir: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, 'claude.cmd');
  fs.writeFileSync(full, content);
  return full;
}

function writeNpmCmd(dir: string, globalBin: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, 'npm.cmd');
  fs.writeFileSync(full, `@echo off\r\nif /i "%~1"=="bin" if /i "%~2"=="-g" echo ${globalBin}\r\n`);
  return full;
}

describe('execCaptured', () => {
  it('builds the double-quote cmd /d /s /c line for .cmd scripts (all platforms)', () => {
    expect(buildCmdScriptCmdLine('C:\\Users\\John Doe\\npm\\claude.cmd', ['--version'])).toBe(
      '""C:\\Users\\John Doe\\npm\\claude.cmd" --version"',
    );
    expect(buildCmdScriptCmdLine('C:\\npm\\claude.cmd', ['bin', '-g'])).toBe(
      '""C:\\npm\\claude.cmd" bin -g"',
    );
  });

  it('captures stdout from a native executable without a shell (all platforms)', async () => {
    const out = await execCaptured(process.execPath, ['-e', 'process.stdout.write("hello")']);
    expect(out).toBe('hello');
  });

  it.runIf(process.platform === 'win32')(
    'runs a .cmd script via cmd.exe and returns trimmed stdout (EINVAL regression)',
    async () => {
      const cmd = writeClaudeCmd(path.join(tmpBase, 'bin'), WORKING_CMD);
      expect(await execCaptured(cmd, ['--version'], { platform: 'win32' })).toBe(
        '2.1.220-mock (Claude Code)',
      );
    },
  );
});

describe('resolveClaudeCli (Windows .cmd, real subprocesses)', () => {
  it.runIf(process.platform === 'win32')(
    'resolves a claude.cmd candidate with the DEFAULT verifier',
    async () => {
      const bin = path.join(tmpBase, 'bin');
      writeClaudeCmd(bin, WORKING_CMD);
      const resolution = await resolveClaudeCli({
        platform: 'win32',
        pathEnv: bin,
        homeDir: tmpBase,
        npmBinDir: async () => undefined,
      });
      expect(resolution.ok).toBe(true);
      expect(resolution.command).toBe(path.join(bin, 'claude.cmd'));
      expect(resolution.source).toBe('path');
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves a .cmd candidate whose directory contains spaces',
    async () => {
      const bin = path.join(tmpBase, 'resolver probe', 'bin');
      writeClaudeCmd(bin, WORKING_CMD);
      const resolution = await resolveClaudeCli({
        platform: 'win32',
        pathEnv: bin,
        homeDir: tmpBase,
        npmBinDir: async () => undefined,
      });
      expect(resolution.ok).toBe(true);
      expect(resolution.command).toBe(path.join(bin, 'claude.cmd'));
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves a native claude.exe candidate with the DEFAULT verifier',
    async () => {
      const bin = path.join(tmpBase, 'native bin');
      fs.mkdirSync(bin, { recursive: true });
      const exe = path.join(bin, 'claude.exe');
      fs.copyFileSync(process.execPath, exe);
      const resolution = await resolveClaudeCli({
        platform: 'win32',
        pathEnv: bin,
        homeDir: tmpBase,
        npmBinDir: async () => undefined,
      });
      expect(resolution.ok).toBe(true);
      expect(resolution.command).toBe(exe);
      expect(resolution.version).toMatch(/^v\d+\.\d+\.\d+/);
    },
  );

  it.runIf(process.platform === 'win32')(
    'skips a broken .cmd candidate and continues to the next PATH dir',
    async () => {
      const brokenBin = path.join(tmpBase, 'broken');
      const goodBin = path.join(tmpBase, 'good');
      writeClaudeCmd(brokenBin, BROKEN_CMD);
      writeClaudeCmd(goodBin, WORKING_CMD);
      const resolution = await resolveClaudeCli({
        platform: 'win32',
        pathEnv: `${brokenBin};${goodBin}`,
        homeDir: tmpBase,
        npmBinDir: async () => undefined,
      });
      expect(resolution.ok).toBe(true);
      expect(resolution.command).toBe(path.join(goodBin, 'claude.cmd'));
    },
  );

  it.runIf(process.platform === 'win32')(
    'probeNpmGlobalBin executes npm.cmd and returns its existing bin path',
    async () => {
      const fakeNpmDir = path.join(tmpBase, 'fake npm', 'bin');
      const globalBin = path.join(tmpBase, 'npm global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      writeNpmCmd(fakeNpmDir, globalBin);

      const originalPath = process.env.PATH;
      process.env.PATH = [fakeNpmDir, originalPath].filter(Boolean).join(';');
      try {
        // This is a real `cmd.exe` → `.cmd` subprocess. Direct execFile of
        // npm.cmd would throw EINVAL on Windows; the resolver must return the
        // existing directory printed by the shim, including its spaces.
        await expect(probeNpmGlobalBin('win32', tmpBase, undefined)).resolves.toBe(globalBin);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );
});
