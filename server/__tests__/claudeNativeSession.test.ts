import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { findReadyClaudeNativeSession } from '../src/providers/hook/claude/claudeNativeSession.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeRecord(record: Record<string, unknown>): { root: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-session-'));
  temporaryRoots.push(root);
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sessions', '123.json'),
    JSON.stringify({ ...record, cwd: record.cwd ?? cwd }),
  );
  return { root, cwd };
}

describe('findReadyClaudeNativeSession', () => {
  it('accepts an exact live interactive idle session', () => {
    const sessionId = 'session-exact';
    const { root, cwd } = writeRecord({
      sessionId,
      pid: process.pid,
      status: 'idle',
      kind: 'interactive',
    });

    expect(findReadyClaudeNativeSession(root, sessionId, cwd)).toMatchObject({
      sessionId,
      cwd,
      pid: process.pid,
      status: 'idle',
      kind: 'interactive',
    });
  });

  it('rejects stale, mismatched, or non-interactive metadata', () => {
    const sessionId = 'session-exact';
    const { root, cwd } = writeRecord({
      sessionId,
      pid: process.pid,
      status: 'idle',
      kind: 'non-interactive',
    });

    expect(findReadyClaudeNativeSession(root, sessionId, cwd)).toBeUndefined();
    expect(findReadyClaudeNativeSession(root, 'other-session', cwd)).toBeUndefined();
    expect(findReadyClaudeNativeSession(root, sessionId, path.join(root, 'other'))).toBeUndefined();
  });

  it('does not treat a dead process record as readiness', () => {
    const { root, cwd } = writeRecord({
      sessionId: 'session-dead',
      pid: 2147483647,
      status: 'idle',
      kind: 'interactive',
    });

    expect(findReadyClaudeNativeSession(root, 'session-dead', cwd)).toBeUndefined();
  });
});
