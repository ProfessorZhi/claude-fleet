import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MissionRecord, UsageRecord } from '../../core/src/ledgerContracts.js';
import type { WorktreeRecord } from '../../core/src/runtimeContracts.js';
import { FleetLedgerStore } from '../src/fleetLedgerStore.js';
import {
  emptyFleetLedgerSnapshot,
  FleetSnapshotConflictError,
  FleetSnapshotCorruptionError,
  FleetSnapshotLockTimeoutError,
  InMemoryFleetSnapshotPersistence,
  JsonFileFleetSnapshotPersistence,
} from '../src/persistence/fleetSnapshotPersistence.js';

const mission: MissionRecord = {
  missionId: 'mission-1',
  title: 'Telemetry',
  objective: 'Normalize runtime signals',
  status: 'planned',
  createdAt: 1,
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    usageId: 'usage-1',
    instanceId: 'agent-1',
    capturedAt: 2,
    tokens: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    source: 'runtime',
    availability: 'available',
    confidence: 'exact',
    estimateOrActual: 'actual',
    ...overrides,
  };
}

describe('FleetLedgerStore', () => {
  it('stores defensive copies and supports mission/work-item queries', () => {
    const store = new FleetLedgerStore();
    store.upsertMission(mission);
    const saved = store.getMission('mission-1');
    expect(saved).toEqual(mission);

    saved!.title = 'mutated outside the store';
    expect(store.getMission('mission-1')?.title).toBe('Telemetry');
  });

  it('keeps usage records independent from quota and cost records', () => {
    const store = new FleetLedgerStore();
    store.recordUsage(usage());
    store.recordQuota({
      snapshotId: 'quota-1',
      resourceAccountId: 'account-1',
      window: 'weekly',
      capturedAt: 3,
      used: { amount: 20, unit: 'tokens' },
      source: 'resource',
      availability: 'available',
      confidence: 'high',
      estimateOrActual: 'actual',
    });

    expect(store.listUsage('agent-1')[0].tokens?.totalTokens).toBe(13);
    expect(store.listQuota('account-1')[0].used?.amount).toBe(20);
  });

  it('rejects secret-bearing payloads before they enter the ledger', () => {
    const store = new FleetLedgerStore();
    const unsafe = {
      ...usage({ usageId: 'unsafe' }),
      apiKey: 'do-not-store',
    } as unknown as UsageRecord;
    expect(() => store.recordUsage(unsafe)).toThrow(/forbidden/i);
    expect(store.listUsage()).toHaveLength(0);
  });

  it('records launch-new recommendations without executing them', () => {
    const store = new FleetLedgerStore();
    store.recordAssignment({
      decisionId: 'decision-1',
      missionId: 'mission-1',
      workItemId: 'work-1',
      action: 'launch_new',
      candidateInstanceIds: [],
      policyMode: 'suggest',
      approval: 'pending',
      strategyVersion: 'v1',
      source: 'strategy',
      availability: 'available',
      confidence: 'medium',
      estimateOrActual: 'estimate',
      createdAt: 4,
    });

    expect(store.listAssignments('work-1')[0].action).toBe('launch_new');
    expect(store.listSessions()).toHaveLength(0);
  });

  it('restores mission, work item, usage, assignment, and worktree metadata from a snapshot', () => {
    const persistence = new InMemoryFleetSnapshotPersistence();
    const first = new FleetLedgerStore({ persistence });
    first.upsertMission(mission);
    first.upsertWorkItem({
      workItemId: 'work-1',
      missionId: 'mission-1',
      title: 'Normalize events',
      objective: 'Create a safe event boundary',
      status: 'queued',
      acceptanceCriteria: ['tests pass'],
      createdAt: 2,
    });
    first.recordUsage(usage());
    first.recordAssignment({
      decisionId: 'decision-1',
      missionId: 'mission-1',
      workItemId: 'work-1',
      action: 'launch_new',
      candidateInstanceIds: [],
      policyMode: 'suggest',
      approval: 'pending',
      strategyVersion: 'v1',
      source: 'strategy',
      availability: 'available',
      confidence: 'medium',
      estimateOrActual: 'estimate',
      createdAt: 3,
    });
    const worktree: WorktreeRecord = {
      worktreeId: 'wt-1',
      repo: 'F:/repo',
      worktreePath: 'F:/repo/.worktrees/work-1',
      branch: 'fleet/work-1',
      workItemId: 'work-1',
      status: 'active',
      createdAt: 4,
    };
    first.upsertWorktree(worktree);

    const restored = new FleetLedgerStore({ persistence });
    expect(restored.getMission('mission-1')).toEqual(mission);
    expect(restored.getWorkItem('work-1')?.title).toBe('Normalize events');
    expect(restored.listUsage('agent-1')[0].tokens?.totalTokens).toBe(13);
    expect(restored.listAssignments('work-1')[0].decisionId).toBe('decision-1');
    expect(restored.getWorktree('wt-1')).toEqual(worktree);
  });

  it('writes a bounded JSON snapshot without secret-bearing fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-ledger-'));
    const filePath = join(directory, 'ledger.json');
    try {
      const persistence = new JsonFileFleetSnapshotPersistence(filePath);
      const store = new FleetLedgerStore({ persistence });
      store.upsertMission(mission);

      const raw = readFileSync(filePath, 'utf8');
      expect(raw).toContain('mission-1');
      expect(raw).not.toMatch(/transcript|apiKey|authorization|password/i);
      expect(new FleetLedgerStore({ persistence }).getMission('mission-1')).toEqual(mission);
      expect(JSON.parse(raw)).toMatchObject({
        schema: 'claude-fleet.ledger',
        version: 1,
        revision: 1,
      });
      expect(existsSync(`${filePath}.lock`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a legacy v1 snapshot and upgrades it on the next commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-legacy-'));
    const filePath = join(directory, 'ledger.json');
    try {
      const legacy = emptyFleetLedgerSnapshot();
      delete legacy.schema;
      delete legacy.revision;
      writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

      const persistence = new JsonFileFleetSnapshotPersistence(filePath);
      expect(persistence.load()).toMatchObject({
        schema: 'claude-fleet.ledger',
        version: 1,
        revision: 0,
      });

      const store = new FleetLedgerStore({ persistence });
      store.upsertMission(mission);
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
        schema: 'claude-fleet.ledger',
        revision: 1,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed JSON, unsupported schema, and unsupported version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-corrupt-'));
    const filePath = join(directory, 'ledger.json');
    try {
      writeFileSync(filePath, '{ not-json', 'utf8');
      expect(() => new JsonFileFleetSnapshotPersistence(filePath).load()).toThrow(
        FleetSnapshotCorruptionError,
      );

      const unsupportedSchema = emptyFleetLedgerSnapshot();
      unsupportedSchema.schema = 'other-ledger' as typeof unsupportedSchema.schema;
      writeFileSync(filePath, JSON.stringify(unsupportedSchema), 'utf8');
      expect(() => new JsonFileFleetSnapshotPersistence(filePath).load()).toThrow(
        FleetSnapshotCorruptionError,
      );

      const unsupportedVersion = { ...emptyFleetLedgerSnapshot(), version: 2 };
      writeFileSync(filePath, JSON.stringify(unsupportedVersion), 'utf8');
      expect(() => new JsonFileFleetSnapshotPersistence(filePath).load()).toThrow(
        FleetSnapshotCorruptionError,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not silently overwrite a snapshot from a stale writer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-conflict-'));
    const filePath = join(directory, 'ledger.json');
    try {
      const firstPersistence = new JsonFileFleetSnapshotPersistence(filePath);
      const secondPersistence = new JsonFileFleetSnapshotPersistence(filePath);
      const first = new FleetLedgerStore({ persistence: firstPersistence });
      const second = new FleetLedgerStore({ persistence: secondPersistence });

      first.upsertMission(mission);
      expect(() =>
        second.upsertMission({
          ...mission,
          missionId: 'mission-2',
          title: 'Stale writer',
        }),
      ).toThrow(FleetSnapshotConflictError);
      expect(second.listMissions()).toEqual([]);
      expect(new FleetLedgerStore({ persistence: firstPersistence }).listMissions()).toEqual([
        mission,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails rather than writing while another writer holds the lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-lock-'));
    const filePath = join(directory, 'ledger.json');
    const lockPath = `${filePath}.lock`;
    try {
      const persistence = new JsonFileFleetSnapshotPersistence(filePath, {
        lockTimeoutMs: 20,
        lockRetryMs: 1,
        staleLockMs: 60_000,
      });
      writeFileSync(lockPath, JSON.stringify({ pid: 99999, createdAt: Date.now() }), 'utf8');
      expect(() => persistence.save(emptyFleetLedgerSnapshot())).toThrow(
        FleetSnapshotLockTimeoutError,
      );
      expect(existsSync(filePath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a stale lock and recovers on restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-fleet-stale-lock-'));
    const filePath = join(directory, 'ledger.json');
    const lockPath = `${filePath}.lock`;
    try {
      const persistence = new JsonFileFleetSnapshotPersistence(filePath, {
        lockTimeoutMs: 100,
        lockRetryMs: 1,
        staleLockMs: 1,
      });
      writeFileSync(lockPath, 'stale', 'utf8');
      const staleTime = new Date(Date.now() - 100);
      utimesSync(lockPath, staleTime, staleTime);
      persistence.save(emptyFleetLedgerSnapshot());
      expect(existsSync(lockPath)).toBe(false);
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ revision: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
