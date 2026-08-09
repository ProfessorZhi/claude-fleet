import { describe, expect, it } from 'vitest';

import type { QuotaSnapshot } from '../../core/src/ledgerContracts.js';
import type { FleetInstance, WorkItem } from '../../core/src/runtimeContracts.js';
import { FleetStrategyAdapter } from '../src/fleetStrategy.js';

const workItem: WorkItem = {
  workItemId: 'work-1',
  missionId: 'mission-1',
  title: 'Implement control plane',
  objective: 'Add an explainable assignment recommendation.',
  acceptanceCriteria: ['tests pass'],
  status: 'queued',
  repo: 'F:/repo',
  worktree: 'F:/repo/.worktrees/work-1',
  createdAt: 1,
};

function instance(overrides: Partial<FleetInstance> = {}): FleetInstance {
  return {
    instanceId: 'agent-1',
    runtime: 'claude-code',
    role: 'worker',
    managedByFleet: true,
    status: 'idle',
    repo: 'F:/repo',
    worktree: 'F:/repo/.worktrees/agent-1',
    createdAt: 1,
    ...overrides,
  };
}

const quota: QuotaSnapshot = {
  snapshotId: 'quota-1',
  resourceAccountId: 'account-1',
  runtime: 'claude-code',
  window: 'weekly',
  capturedAt: 1,
  remaining: { amount: 100, unit: 'credits' },
  source: 'resource',
  availability: 'available',
  confidence: 'high',
  estimateOrActual: 'actual',
};

describe('FleetStrategyAdapter', () => {
  it('prefers an idle eligible instance over a busy instance', () => {
    const recommendation = new FleetStrategyAdapter().recommend({
      now: 1000,
      workItem,
      policy: { mode: 'suggest' },
      candidates: [
        { instance: instance({ instanceId: 'busy', status: 'working' }) },
        { instance: instance({ instanceId: 'idle' }) },
      ],
    });

    expect(recommendation.action).toBe('assign_existing');
    expect(recommendation.selectedInstanceId).toBe('idle');
    expect(recommendation.factors.some((factor) => factor.key === 'idle_capacity')).toBe(true);
  });

  it('proposes a new launch when concurrency and quota policy permit it', () => {
    const recommendation = new FleetStrategyAdapter().recommend({
      now: 1000,
      workItem,
      policy: { mode: 'suggest', maxConcurrentInstances: 2, quotaReserve: 20 },
      candidates: [{ instance: instance({ instanceId: 'busy', status: 'error' }) }],
      quotas: [quota],
      directive: {
        directiveId: 'directive-1',
        requestedBy: 'codex-primary',
        target: { runtime: 'codex-cli', modelId: 'codex-reviewer' },
        objective: 'throughput',
        priority: 10,
        reason: 'Use the available reviewer capacity before reset.',
        createdAt: 900,
        expiresAt: 2000,
      },
      launchTemplates: [
        {
          runtime: 'claude-code',
          role: 'worker',
          repo: 'F:/repo',
          worktree: 'F:/repo/.worktrees/new-claude',
          providerDisplayName: 'Anthropic',
        },
        {
          runtime: 'codex-cli',
          role: 'reviewer',
          repo: 'F:/repo',
          worktree: 'F:/repo/.worktrees/new-codex',
          modelId: 'codex-reviewer',
        },
      ],
    });

    expect(recommendation.action).toBe('launch_new');
    expect(recommendation.proposedLaunchTemplate).toMatchObject({
      runtime: 'codex-cli',
      modelId: 'codex-reviewer',
    });
    expect(recommendation.directiveId).toBe('directive-1');
  });

  it('does not fabricate quota when the reserve has no evidence', () => {
    const recommendation = new FleetStrategyAdapter().recommend({
      now: 1000,
      workItem,
      policy: { mode: 'suggest', maxConcurrentInstances: 2, quotaReserve: 20 },
      candidates: [{ instance: instance({ status: 'error' }) }],
      launchTemplates: [{ runtime: 'claude-code', role: 'worker', repo: 'F:/repo' }],
    });

    expect(recommendation.action).toBe('defer');
    expect(recommendation.expectedQuota).toBeUndefined();
    expect(recommendation.constraints).toContainEqual(
      expect.objectContaining({ key: 'quota_reserve', blocking: true }),
    );
  });

  it('preserves explicit quota impact separately from estimated tokens', () => {
    const recommendation = new FleetStrategyAdapter().recommend({
      now: 1000,
      workItem,
      policy: { mode: 'suggest' },
      candidates: [
        {
          instance: instance(),
          expected: {
            value: { tokens: { totalTokens: 500 }, quotaImpact: { amount: 2, unit: 'credits' } },
            source: 'external',
            availability: 'available',
            confidence: 'high',
            estimateOrActual: 'estimate',
          },
        },
      ],
    });

    expect(recommendation.expected?.value.tokens?.totalTokens).toBe(500);
    expect(recommendation.expectedQuota?.value).toEqual({ amount: 2, unit: 'credits' });
  });
});
