import { afterEach, describe, expect, it } from 'vitest';

import type { QualitySignal, UsageRecord } from '../../core/src/ledgerContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FleetControlClient } from '../src/fleetControlClient.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';

const TOKEN = 'quality-cost-test-token';

function usage(usageId: string, cost: number): UsageRecord {
  return {
    usageId,
    instanceId: 'worker-1',
    sessionId: 'session-1',
    missionId: 'mission-1',
    workItemId: 'work-1',
    runtime: 'claude-code',
    modelId: 'test-model',
    capturedAt: 100,
    durationMs: 500,
    tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    cost: { amount: cost, currency: 'USD', basis: 'api-equivalent' },
    source: 'agentmetrics',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
  };
}

function quality(overrides: Partial<QualitySignal> = {}): QualitySignal {
  return {
    signalId: 'pr-42',
    kind: 'pull-request',
    missionId: 'mission-1',
    workItemId: 'work-1',
    instanceId: 'worker-1',
    pullRequestId: '42',
    outcome: 'passed',
    summary: 'Pull request merged after CI and review.',
    metadata: { state: 'merged', ci: 'passed', review: 'approved' },
    capturedAt: 100,
    source: 'scm',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
    ...overrides,
  };
}

describe('Coordinator cost and quality evidence', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  it('aggregates compatible cost, keeps WorkItem identity, and exposes PR evidence over HTTP', async () => {
    const service = new FleetControlService({ now: () => 200 });
    handle = await createHttpServer({
      embedded: true,
      token: TOKEN,
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: TOKEN });

    for (const [requestId, record] of [
      ['usage-1-request', usage('usage-1', 0.42)],
      ['usage-2-request', usage('usage-2', 0.13)],
    ] as const) {
      await expect(
        client.ingestTelemetry({
          usage: record,
          idempotencyKey: requestId,
          requestId,
          requestedBy: 'codex-primary',
          mode: 'approve',
          createdAt: 100,
        }),
      ).resolves.toMatchObject({ deduplicated: false, response: { decision: 'accepted' } });

      await expect(
        client.ingestTelemetry({
          usage: record,
          idempotencyKey: requestId,
          requestId,
          requestedBy: 'codex-primary',
          mode: 'approve',
          createdAt: 100,
        }),
      ).resolves.toMatchObject({ deduplicated: true, response: { decision: 'accepted' } });
    }

    await expect(
      client.submit({
        requestId: 'quality-pr-42',
        action: 'record_quality',
        mode: 'approve',
        requestedBy: 'codex-primary',
        workItemId: 'work-1',
        quality: quality(),
        createdAt: 100,
      }),
    ).resolves.toMatchObject({ decision: 'accepted', quality: { pullRequestId: '42' } });

    const metrics = await client.getMetrics('worker-1');
    expect(metrics.usage.every((record) => record.workItemId === 'work-1')).toBe(true);
    expect(metrics.totals.cost).toEqual({
      amount: 0.55,
      currency: 'USD',
      basis: 'api-equivalent',
    });

    const workItemMetrics = await client.getMetrics(undefined, 'work-1');
    expect(workItemMetrics.usage).toHaveLength(2);
    expect(workItemMetrics.totals.cost?.amount).toBe(0.55);

    await expect(client.getQuality('work-1')).resolves.toEqual([
      expect.objectContaining({ signalId: 'pr-42', pullRequestId: '42', outcome: 'passed' }),
    ]);
  });

  it('rejects raw quality payloads and does not persist them', async () => {
    const service = new FleetControlService({ now: () => 200 });
    const response = await service.submit({
      requestId: 'quality-unsafe',
      action: 'record_quality',
      mode: 'approve',
      requestedBy: 'codex-primary',
      quality: quality({ metadata: { transcript: 'must not persist' } }),
      createdAt: 100,
    });

    expect(response).toMatchObject({ decision: 'rejected' });
    expect(service.getQuality()).toHaveLength(0);
    expect(JSON.stringify(response)).not.toContain('must not persist');
  });
});
