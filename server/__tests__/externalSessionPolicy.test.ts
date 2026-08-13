import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isPersistedExternalSessionFresh } from '../src/externalSessionPolicy.js';

describe('persisted external session restore policy', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const file of tempFiles.splice(0)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // The test file may already have been removed.
      }
    }
  });

  it('restores a transcript that was recently active', () => {
    const file = path.join(os.tmpdir(), `claude-fleet-active-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, '{}\n', 'utf8');
    const now = fs.statSync(file).mtimeMs + 30_000;

    expect(isPersistedExternalSessionFresh(file, now, 120_000)).toBe(true);
  });

  it('does not restore an old transcript after a restart', () => {
    const file = path.join(os.tmpdir(), `claude-fleet-stale-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, '{}\n', 'utf8');
    const now = fs.statSync(file).mtimeMs + 120_001;

    expect(isPersistedExternalSessionFresh(file, now, 120_000)).toBe(false);
  });

  it('does not restore a transcript that no longer exists', () => {
    const file = path.join(os.tmpdir(), `claude-fleet-missing-${Date.now()}.jsonl`);

    expect(isPersistedExternalSessionFresh(file, Date.now(), 120_000)).toBe(false);
  });
});
