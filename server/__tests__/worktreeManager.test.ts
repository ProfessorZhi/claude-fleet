import { describe, expect, it } from 'vitest';

import { FleetLedgerStore } from '../src/fleetLedgerStore.js';
import {
  LedgerWorktreeManager,
  WorktreeConflictError,
} from '../src/persistence/worktreeManager.js';

const request = (overrides: Partial<Parameters<LedgerWorktreeManager['create']>[0]> = {}) => ({
  worktreeId: 'wt-1',
  repo: 'F:/repo',
  worktreePath: 'F:/repo/.worktrees/one',
  branch: 'fleet/one',
  workItemId: 'work-1',
  createdAt: 1,
  ...overrides,
});

describe('LedgerWorktreeManager', () => {
  it('creates and records an active worktree with an optional provisioner', async () => {
    const ledger = new FleetLedgerStore();
    const manager = new LedgerWorktreeManager(ledger, {
      async create() {
        return {
          worktreePath: 'F:/repo/.worktrees/provisioned',
          branch: 'fleet/provisioned',
        };
      },
    });

    const created = await manager.create(request());

    expect(created).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: 'F:/repo/.worktrees/provisioned',
      branch: 'fleet/provisioned',
      status: 'active',
    });
    expect(ledger.getWorktree('wt-1')).toEqual(created);
  });

  it('detects path and branch conflicts while ignoring released records', async () => {
    const ledger = new FleetLedgerStore();
    const manager = new LedgerWorktreeManager(ledger);
    await manager.create(request());

    const pathConflict = await manager.checkConflict(
      request({ worktreeId: 'wt-2', workItemId: 'work-2' }),
    );
    expect(pathConflict).toMatchObject({ conflict: true });
    expect(pathConflict.conflicts.map((item) => item.reason)).toContain('path');

    const branchConflict = await manager.checkConflict(
      request({
        worktreeId: 'wt-2',
        workItemId: 'work-2',
        worktreePath: 'F:/repo/.worktrees/two',
      }),
    );
    expect(branchConflict.conflicts.map((item) => item.reason)).toContain('branch');

    await manager.record({
      ...(await ledger.getWorktree('wt-1'))!,
      status: 'released',
      releasedAt: 2,
    });
    await expect(manager.checkConflict(request({ worktreeId: 'wt-2' }))).resolves.toEqual({
      conflict: false,
      conflicts: [],
    });
  });

  it('fails creation instead of silently sharing an active path', async () => {
    const manager = new LedgerWorktreeManager(new FleetLedgerStore());
    await manager.create(request());

    await expect(
      manager.create(request({ worktreeId: 'wt-2', workItemId: 'work-2' })),
    ).rejects.toBeInstanceOf(WorktreeConflictError);
  });

  it('releases provisioned worktrees before marking their ledger record released', async () => {
    const released: string[] = [];
    const manager = new LedgerWorktreeManager(new FleetLedgerStore(), {
      async create() {
        return {};
      },
      async release(input) {
        released.push(input.worktreeId ?? 'missing');
      },
    });

    await manager.create(request());
    const record = await manager.release('wt-1');

    expect(released).toEqual(['wt-1']);
    expect(record.status).toBe('released');
    expect(record.releasedAt).toEqual(expect.any(Number));
    await expect(manager.release('wt-1')).resolves.toEqual(record);
    expect(released).toEqual(['wt-1']);
  });
});
