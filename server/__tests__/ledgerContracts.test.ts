import { describe, expect, it } from 'vitest';

import {
  type AssignmentDecision,
  type CostAmount,
  isLedgerPayloadSafe,
  type MissionRecord,
  normalizeSafeMetadata,
  type QuotaSnapshot,
  type ResourceAccount,
  type TokenUsage,
  type UsageRecord,
  validateLedgerPayload,
} from '../../core/src/ledgerContracts.js';

describe('Fleet Ledger contracts', () => {
  it('keeps token, cost, and quota values structurally separate', () => {
    const tokens: TokenUsage = {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 130,
    };
    const cost: CostAmount = {
      amount: 0.42,
      currency: 'USD',
      basis: 'api-equivalent',
    };
    const quota: QuotaSnapshot = {
      snapshotId: 'quota-1',
      resourceAccountId: 'account-1',
      window: 'weekly',
      capturedAt: 1_000,
      remaining: { amount: 80, unit: 'credits' },
      source: 'resource',
      availability: 'available',
      confidence: 'high',
      estimateOrActual: 'actual',
    };
    const usage: UsageRecord = {
      usageId: 'usage-1',
      sessionId: 'session-1',
      capturedAt: 1_000,
      tokens,
      cost,
      source: 'runtime',
      availability: 'available',
      confidence: 'exact',
      estimateOrActual: 'actual',
    };

    expect(usage.tokens?.totalTokens).toBe(130);
    expect(usage.cost?.amount).toBe(0.42);
    expect(quota.remaining).toEqual({ amount: 80, unit: 'credits' });
    expect(JSON.stringify(usage)).not.toContain('quota');
  });

  it('represents expected and actual metrics with explicit provenance', () => {
    const mission: MissionRecord = {
      missionId: 'mission-1',
      title: 'Ledger contracts',
      objective: 'Define safe durable metadata',
      status: 'active',
      createdAt: 1_000,
      metrics: {
        expected: {
          value: { durationMs: 60_000, tokens: { totalTokens: 5_000 } },
          source: 'strategy',
          availability: 'available',
          confidence: 'medium',
          estimateOrActual: 'estimate',
        },
        actual: {
          value: { durationMs: 42_000, tokens: { totalTokens: 3_200 } },
          source: 'runtime',
          availability: 'available',
          confidence: 'exact',
          estimateOrActual: 'actual',
          observedAt: 2_000,
        },
      },
    };

    expect(mission.metrics?.expected?.estimateOrActual).toBe('estimate');
    expect(mission.metrics?.actual?.estimateOrActual).toBe('actual');
    expect(mission.metrics?.actual?.value.durationMs).toBe(42_000);
  });

  it('records assignment recommendations without executing them', () => {
    const decision: AssignmentDecision = {
      decisionId: 'decision-1',
      missionId: 'mission-1',
      workItemId: 'work-1',
      action: 'launch_new',
      candidateInstanceIds: ['agent-1'],
      launchTemplate: {
        runtime: 'codex-cli',
        role: 'reviewer',
        repo: 'F:/repo',
        worktree: 'F:/repo/.worktrees/review',
        modelId: 'codex-default',
      },
      policyMode: 'suggest',
      approval: 'pending',
      strategyVersion: 'strategy-v1',
      rationale: 'A fresh reviewer instance is recommended.',
      createdAt: 1_000,
      source: 'strategy',
      availability: 'available',
      confidence: 'medium',
      estimateOrActual: 'estimate',
    };

    expect(decision.action).toBe('launch_new');
    expect(decision.approval).toBe('pending');
    expect(decision.launchTemplate?.runtime).toBe('codex-cli');
  });

  it('models resource accounts without credentials or auth material', () => {
    const account: ResourceAccount = {
      resourceAccountId: 'account-1',
      kind: 'subscription',
      displayName: 'Primary coding plan',
      providerDisplayName: 'Example Provider',
      runtime: 'claude-code',
      quotaScopes: ['weekly'],
      enabled: true,
      source: 'resource',
      availability: 'partial',
      confidence: 'unknown',
    };

    expect(account.displayName).toBe('Primary coding plan');
    expect('apiKey' in account).toBe(false);
    expect('authorization' in account).toBe(false);
  });
});

describe('Fleet Ledger safety boundary', () => {
  it('rejects forbidden secrets, auth fields, transcripts, and raw events', () => {
    const unsafe = {
      source: 'runtime',
      nested: {
        apiKey: 'secret',
        authorization: 'Bearer secret',
        transcript: 'full conversation',
        rawEvent: { type: 'tool_started' },
      },
    };

    const errors = validateLedgerPayload(unsafe);

    expect(errors).toHaveLength(4);
    expect(isLedgerPayloadSafe(unsafe)).toBe(false);
    expect(errors.join(' ')).toContain('forbidden');
  });

  it('normalizes safe metadata and removes forbidden fields', () => {
    const normalized = normalizeSafeMetadata({
      note: 'line one\nline two',
      count: 3,
      nested: { ok: true, secret: 'remove-me' },
      environment: { HOME: 'private' },
      transcript: 'remove-me',
      nonFinite: Number.POSITIVE_INFINITY,
    });

    expect(normalized).toEqual({
      note: 'line one line two',
      count: 3,
      nested: { ok: true },
    });
    expect(isLedgerPayloadSafe(normalized)).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain('remove-me');
  });

  it('accepts fake ledger payloads containing only safe metadata', () => {
    expect(
      isLedgerPayloadSafe({
        source: 'strategy',
        confidence: 'medium',
        estimateOrActual: 'estimate',
        expected: { durationMs: 10_000 },
      }),
    ).toBe(true);
  });
});
