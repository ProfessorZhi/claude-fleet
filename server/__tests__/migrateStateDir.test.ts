/**
 * Spec 006 — migrateStateDir tests.
 *
 * Covers: old→new copy, idempotency, new-exists no-op, failure safety
 * (old preserved), marker behavior, no-secret logging.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os.homedir so the migration targets a temp dir (same pattern as
// fileStateAdapter.test.ts / claudeHookInstaller.test.ts).
const MOCK_HOME = path.join(os.tmpdir(), 'pxl-migrate-home-mock');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => MOCK_HOME };
});

import {
  LEGACY_STATE_DIR_NAME,
  migrateStateDir,
  MIGRATION_MARKER,
  STATE_DIR_NAME,
} from '../src/migrateStateDir.js';

let oldDir: string;
let newDir: string;

beforeEach(() => {
  fs.mkdirSync(MOCK_HOME, { recursive: true });
  oldDir = path.join(MOCK_HOME, LEGACY_STATE_DIR_NAME);
  newDir = path.join(MOCK_HOME, STATE_DIR_NAME);
});

afterEach(() => {
  try {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedLegacy(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(oldDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

describe('migrateStateDir — Spec 006', () => {
  it('no-op when the legacy dir is missing', () => {
    const result = migrateStateDir(() => {});
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('old-missing');
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('copies the legacy tree into ~/.claude-fleet and writes a marker', () => {
    seedLegacy({
      'config.json': '{"vscode":{"soundEnabled":true}}',
      'hooks/claude-hook.js': '// hook',
      'vscode-state.json': '{"agents":[]}',
      'layout.json': '{"version":1}',
    });
    const logs: string[] = [];
    const result = migrateStateDir((m) => logs.push(m));

    expect(result.migrated).toBe(true);
    expect(result.reason).toBe('done');
    expect(result.copiedFiles).toBe(4);
    for (const f of ['config.json', 'hooks/claude-hook.js', 'vscode-state.json', 'layout.json']) {
      expect(fs.existsSync(path.join(newDir, f))).toBe(true);
    }
    expect(fs.existsSync(path.join(newDir, MIGRATION_MARKER))).toBe(true);
    // Legacy dir preserved.
    expect(fs.existsSync(oldDir)).toBe(true);
    expect(logs.join('\n')).not.toContain('secret');
  });

  it('is idempotent: second run is a no-op', () => {
    seedLegacy({ 'config.json': '{}' });
    migrateStateDir(() => {});
    const second = migrateStateDir(() => {});
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe('already-migrated');
  });

  it('never overwrites an existing new dir without a marker', () => {
    seedLegacy({ 'config.json': '{"old":true}' });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'config.json'), '{"user":true}');

    const result = migrateStateDir(() => {});
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('new-exists');
    // User's new state untouched.
    expect(JSON.parse(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8'))).toEqual({
      user: true,
    });
  });

  it('failure safety: an unexpected new-dir blocker never touches the old dir', () => {
    seedLegacy({ 'config.json': '{"keep":true}' });
    // A FILE where the new dir should be — migration refuses (new-exists),
    // the old dir is preserved untouched, and the blocker file is left alone.
    fs.writeFileSync(newDir, 'blocker');
    const logs: string[] = [];
    const result = migrateStateDir((m) => logs.push(m));

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('new-exists');
    expect(fs.existsSync(oldDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(oldDir, 'config.json'), 'utf-8'))).toEqual({
      keep: true,
    });
    expect(fs.readFileSync(newDir, 'utf-8')).toBe('blocker');
    expect(logs.join('\n')).toMatch(/not overwriting/i);
  });

  it('excludes known cache directory names', () => {
    seedLegacy({
      'config.json': '{}',
      'Cache/CachedData/x': 'big',
      'Crashpad/crash': 'data',
    });
    const result = migrateStateDir(() => {});
    expect(result.migrated).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'Cache'))).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'Crashpad'))).toBe(false);
  });
});
