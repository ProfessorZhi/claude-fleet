import { describe, expect, it } from 'vitest';

import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';

function instance(): FleetInstance {
  return {
    instanceId: 'agent-7',
    displayName: 'minimax1',
    runtime: 'claude-code',
    role: 'worker',
    managedByFleet: true,
    missionId: 'mission-7',
    workItemId: 'work-7',
    sessionId: 'session-7',
    hostId: 'vscode-integrated-terminal',
    workspaceId: 'F:/repo',
    repo: 'F:/repo',
    terminalId: 'terminal-agent-7',
    terminalName: 'Claude Code #7',
    providerDisplayName: 'MiniMax',
    modelId: 'MiniMax-M3',
    status: 'working',
    createdAt: 1_000,
  };
}

describe('FleetControlService live runtime metrics', () => {
  it('creates a session, exposes live elapsed time, and records cumulative tokens', () => {
    let now = 1_000;
    const service = new FleetControlService({ now: () => now });
    service.observeRuntimeInstance(instance());

    now = 2_500;
    expect(service.getMetrics('agent-7')).toMatchObject({
      sessions: [expect.objectContaining({ status: 'active', elapsedMs: 1_500 })],
      quotas: [expect.objectContaining({ availability: 'unavailable', window: 'session' })],
    });

    service.recordLiveUsage(
      'agent-7',
      'claude-code',
      'MiniMax',
      'MiniMax-M3',
      { inputTokens: 100, cachedInputTokens: 200, outputTokens: 30, totalTokens: 330 },
      now,
      1_250,
    );
    expect(service.getMetrics('agent-7').totals.tokens).toEqual({
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 30,
      totalTokens: 330,
    });
    expect(service.getMetrics('agent-7').usage[0]).toMatchObject({
      missionId: 'mission-7',
      workItemId: 'work-7',
      durationMs: 1_250,
    });

    now = 3_000;
    service.markInstanceStopped('agent-7', now);
    expect(service.getMetrics('agent-7').sessions[0]).toMatchObject({
      status: 'stopped',
      endedAt: 3_000,
      elapsedMs: 2_000,
    });
  });

  it('preserves Coordinator WorkItem correlation when a host status update is partial', () => {
    const service = new FleetControlService({ now: () => 2_000 });
    service.observeRuntimeInstance(instance());
    service.observeRuntimeInstance({
      ...instance(),
      missionId: undefined,
      workItemId: undefined,
      status: 'waiting',
      lastActivityAt: 2_000,
    });

    expect(service.listInstances()[0]).toMatchObject({
      missionId: 'mission-7',
      workItemId: 'work-7',
      status: 'waiting',
    });
    expect(service.getMetrics(undefined, 'work-7').sessions[0]).toMatchObject({
      workItemId: 'work-7',
    });
  });

  it('does not double-count a native session after replacing a launch placeholder', () => {
    let now = 1_000;
    const service = new FleetControlService({ now: () => now });
    service.observeRuntimeInstance({
      ...instance(),
      sessionId: 'codex-placeholder',
      runtime: 'codex-cli',
    });

    now = 2_000;
    service.observeRuntimeInstance({
      ...instance(),
      sessionId: 'codex-native-session',
      runtime: 'codex-cli',
      lastActivityAt: now,
    });

    expect(service.getMetrics('agent-7').sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'codex-placeholder',
          status: 'stopped',
          elapsedMs: 0,
        }),
        expect.objectContaining({
          sessionId: 'codex-native-session',
          status: 'active',
          elapsedMs: 1_000,
        }),
      ]),
    );
  });

  it('keeps turn evidence while aggregating a multi-turn session and PR', () => {
    let now = 10_000;
    const service = new FleetControlService({ now: () => now });
    service.observeRuntimeInstance(instance());

    const base = {
      instanceId: 'agent-7',
      sessionId: 'session-7',
      missionId: 'mission-7',
      workItemId: 'work-7',
      source: 'agentmetrics' as const,
      availability: 'available' as const,
      confidence: 'exact' as const,
      estimateOrActual: 'actual' as const,
      aggregation: 'turn' as const,
      costs: {
        apiEquivalent: { amount: 1, currency: 'USD', basis: 'api-equivalent' as const },
        subscription: {
          amount: 0.5,
          currency: 'USD',
          basis: 'subscription-amortized' as const,
          planType: 'Plus',
          billingPeriod: 'weekly' as const,
          periodPrice: 5,
          priceSource: 'official-list' as const,
          fractionOfPeriod: 0.1,
          consumedPercentage: 10,
          confidence: 'medium' as const,
          availability: 'available' as const,
          estimateOrActual: 'estimate' as const,
        },
      },
      quotaImpact: {
        planType: 'Plus',
        billingMode: 'subscription' as const,
        window: 'weekly' as const,
        consumedPercentage: 10,
        fractionOfWindow: 0.1,
        source: 'provider' as const,
        availability: 'available' as const,
        confidence: 'high' as const,
        estimateOrActual: 'actual' as const,
      },
    };
    service.ledger.recordUsage({
      ...base,
      usageId: 'turn-1',
      capturedAt: 10_100,
      turnId: 'turn-1',
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    service.ledger.recordUsage({
      ...base,
      usageId: 'turn-2',
      capturedAt: 10_200,
      turnId: 'turn-2',
      tokens: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });

    now = 11_000;
    const metrics = service.getMetrics(undefined, 'work-7');
    expect(metrics.usage).toHaveLength(2);
    expect(metrics.usage.map((record) => record.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(metrics.totals.tokens).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    expect(metrics.totals.costs).toMatchObject({
      apiEquivalent: { amount: 2, currency: 'USD' },
      subscription: { amount: 1, records: 2, consumedPercentage: 20 },
    });
    expect(metrics.totals.quotaUsage).toEqual([
      expect.objectContaining({ window: 'weekly', consumedPercentage: 20, records: 2 }),
    ]);
    expect(metrics.sessions[0].metrics?.actual?.value).toMatchObject({
      durationMs: 10_000,
      tokens: { totalTokens: 45 },
    });
  });

  it('uses the latest cumulative session snapshot once', () => {
    let now = 20_000;
    const service = new FleetControlService({ now: () => now });
    service.observeRuntimeInstance(instance());
    const record = {
      instanceId: 'agent-7',
      sessionId: 'session-7',
      missionId: 'mission-7',
      workItemId: 'work-7',
      source: 'system' as const,
      availability: 'partial' as const,
      confidence: 'high' as const,
      estimateOrActual: 'actual' as const,
      aggregation: 'session-cumulative' as const,
    };
    service.ledger.recordUsage({
      ...record,
      usageId: 'snapshot-1',
      capturedAt: 20_100,
      tokens: { totalTokens: 100 },
    });
    service.ledger.recordUsage({
      ...record,
      usageId: 'snapshot-2',
      capturedAt: 20_200,
      tokens: { totalTokens: 160 },
    });
    expect(service.getMetrics('agent-7').totals.tokens).toEqual({ totalTokens: 160 });
    expect(service.getMetrics('agent-7').usage).toHaveLength(2);
  });
});
