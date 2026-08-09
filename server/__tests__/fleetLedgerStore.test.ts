import { describe, expect, it } from 'vitest';

import type { MissionRecord, UsageRecord } from '../../core/src/ledgerContracts.js';
import { FleetLedgerStore } from '../src/fleetLedgerStore.js';

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
});
