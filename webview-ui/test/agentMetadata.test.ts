/**
 * Tests for Spec 002 Agent Metadata helpers used by DebugView.
 *
 * Goal: cover the pure functions that render Repo / Provider / Model / Session
 * / Status in the Debug View. The React component itself is verified manually
 * (React Testing Library / jsdom aren't installed in this project).
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { basename, shortSessionId, statusLabel } from '../src/components/agentMetadata.js';

describe('agentMetadata.basename', () => {
  test('returns last segment for POSIX paths', () => {
    assert.equal(basename('/home/user/project'), 'project');
  });

  test('returns last segment for Windows paths', () => {
    assert.equal(basename('C:\\Users\\me\\repo'), 'repo');
    assert.equal(basename('C:/Users/me/repo'), 'repo');
  });

  test('returns last segment for mixed separators', () => {
    assert.equal(basename('/home/user\\repo'), 'repo');
  });

  test('handles trailing slash (returns last non-empty segment)', () => {
    // Trailing / or \ doesn't drop the last segment — `project/` still
    // names the same directory as `project`.
    assert.equal(basename('/home/user/project/'), 'project');
    assert.equal(basename('C:\\Users\\me\\repo\\'), 'repo');
  });

  test('returns original string for empty input', () => {
    assert.equal(basename(''), '');
  });
});

describe('agentMetadata.shortSessionId', () => {
  test('strips .jsonl and truncates to 8 chars', () => {
    assert.equal(
      shortSessionId('/home/user/.claude/projects/foo/a81f2d3c-deadbeef.jsonl'),
      'a81f2d3c',
    );
  });

  test('handles Windows path separators', () => {
    assert.equal(shortSessionId('C:\\Users\\me\\projects\\foo\\a81f2d3c.jsonl'), 'a81f2d3c');
  });

  test('returns "—" for empty / missing', () => {
    assert.equal(shortSessionId(''), '—');
  });

  test('handles short session id (< 8 chars)', () => {
    assert.equal(shortSessionId('/path/ab.jsonl'), 'ab');
  });
});

describe('agentMetadata.statusLabel', () => {
  test('"running" → "Running"', () => {
    assert.equal(statusLabel('running', false), 'Running');
  });

  test('"waiting" → "Waiting"', () => {
    assert.equal(statusLabel('waiting', false), 'Waiting');
  });

  test('"working" → "Working" (Spec 003)', () => {
    assert.equal(statusLabel('working', false), 'Working');
  });

  test('"waiting for input" overrides any status', () => {
    // waitingForInput=true wins even when status is "running".
    assert.equal(statusLabel('running', true), 'Waiting for input');
    assert.equal(statusLabel('waiting', true), 'Waiting for input');
  });

  test('"idle" → "Idle"', () => {
    assert.equal(statusLabel('idle', false), 'Idle');
  });

  test('"error" → "Error"', () => {
    assert.equal(statusLabel('error', false), 'Error');
  });

  test('"stopped" → "Stopped"', () => {
    assert.equal(statusLabel('stopped', false), 'Stopped');
  });

  test('"starting" → "Starting"', () => {
    assert.equal(statusLabel('starting', false), 'Starting');
  });

  test('undefined / unknown status falls back to "Idle"', () => {
    assert.equal(statusLabel(undefined, false), 'Idle');
    assert.equal(statusLabel('something-else', false), 'something-else');
  });
});
