import { describe, expect, it } from 'vitest';

import { FleetControlService } from '../src/fleetControlService.js';
import {
  type TelemetryControlBoundary,
  TelemetryIngestError,
  TelemetryIngestor,
} from '../src/telemetryIngestor.js';

function usage(overrides: Record<string, unknown> = {}) {
  return {
    usageId: 'usage-ingest-1',
    instanceId: 'worker-1',
    workItemId: 'task-1',
    runtime: 'codex-cli',
    modelId: 'gpt-5.3-codex',
    capturedAt: 1_700_000_000_000,
    durationMs: 1_200,
    tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    source: 'agentmetrics',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
    ...overrides,
  };
}

function quota(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: 'quota-ingest-1',
    runtime: 'codex-cli',
    window: 'daily',
    capturedAt: 1_700_000_000_000,
    remaining: { amount: 90, unit: 'requests' },
    source: 'agentmetrics',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
    ...overrides,
  };
}

function instrument(service: FleetControlService): {
  boundary: TelemetryControlBoundary;
  submits: () => number;
} {
  let submitCount = 0;
  return {
    boundary: {
      submit: async (request) => {
        submitCount += 1;
        return service.submit(request);
      },
      getMetrics: (instanceId) => service.getMetrics(instanceId),
    },
    submits: () => submitCount,
  };
}

describe('TelemetryIngestor', () => {
  it('imports normalized usage through record_telemetry and marks unknown quota unavailable', async () => {
    const service = new FleetControlService({ now: () => 1_700_000_000_100 });
    const { boundary } = instrument(service);
    const result = await new TelemetryIngestor(boundary, { now: () => 1_700_000_000_100 }).ingest({
      usage: usage(),
    });

    expect(result.response).toMatchObject({
      decision: 'accepted',
      telemetry: { usageId: 'usage-ingest-1', snapshotId: 'quota-usage-ingest-1' },
    });
    expect(service.getMetrics()).toMatchObject({
      usage: [expect.objectContaining({ usageId: 'usage-ingest-1', source: 'agentmetrics' })],
      quotas: [expect.objectContaining({ availability: 'unavailable', confidence: 'unknown' })],
    });
  });

  it('accepts an explicit quota snapshot without mixing quota into tokens', async () => {
    const service = new FleetControlService();
    const ingestor = new TelemetryIngestor(service);
    await ingestor.ingest({ usage: usage(), quota: quota() });

    const metrics = service.getMetrics();
    expect(metrics.usage[0]?.tokens).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(metrics.quotas[0]).toMatchObject({
      snapshotId: 'quota-ingest-1',
      remaining: { amount: 90, unit: 'requests' },
      availability: 'available',
    });
  });

  it('accepts per-turn cost and quota evidence for session/PR aggregation', async () => {
    const service = new FleetControlService();
    const ingestor = new TelemetryIngestor(service);
    await ingestor.ingest({
      usage: usage({
        usageId: 'usage-turn-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        aggregation: 'turn',
        costs: {
          apiEquivalent: { amount: 0.25, currency: 'USD', basis: 'api-equivalent' },
          subscription: {
            amount: 0.5,
            currency: 'USD',
            basis: 'subscription-amortized',
            planType: 'Plus',
            billingPeriod: 'weekly',
            periodPrice: 5,
            priceSource: 'user-entered',
            fractionOfPeriod: 0.1,
            consumedPercentage: 10,
            confidence: 'high',
            availability: 'available',
            estimateOrActual: 'actual',
          },
        },
        quotaImpact: {
          planType: 'Plus',
          billingMode: 'subscription',
          window: 'weekly',
          consumedPercentage: 10,
          fractionOfWindow: 0.1,
          source: 'provider',
          availability: 'available',
          confidence: 'high',
          estimateOrActual: 'actual',
        },
      }),
    });

    expect(service.getMetrics().usage[0]).toMatchObject({
      turnId: 'turn-1',
      aggregation: 'turn',
      costs: { apiEquivalent: { amount: 0.25 } },
      quotaImpact: { consumedPercentage: 10, window: 'weekly' },
    });
  });

  it('is idempotent for retries and rejects a conflicting reuse', async () => {
    const service = new FleetControlService();
    const { boundary, submits } = instrument(service);
    const ingestor = new TelemetryIngestor(boundary);
    const first = await ingestor.ingest({ usage: usage(), idempotencyKey: 'run-1' });
    const second = await ingestor.ingest({ usage: usage(), idempotencyKey: 'run-1' });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(submits()).toBe(1);
    await expect(
      ingestor.ingest({
        usage: usage({ tokens: { inputTokens: 99, outputTokens: 5, totalTokens: 104 } }),
        idempotencyKey: 'run-1',
      }),
    ).rejects.toThrow('different telemetry payload');
    expect(service.getMetrics().usage).toHaveLength(1);
  });

  it('rejects raw transcript, secret fields, and non-agentmetrics sources', async () => {
    const service = new FleetControlService();
    const ingestor = new TelemetryIngestor(service);

    await expect(
      ingestor.ingest({ usage: { ...usage(), transcript: 'raw transcript' } }),
    ).rejects.toBeInstanceOf(TelemetryIngestError);
    await expect(
      ingestor.ingest({ usage: { ...usage(), apiKey: 'sk-test-secret' } }),
    ).rejects.toThrow('forbidden');
    await expect(ingestor.ingest({ usage: usage({ source: 'runtime' }) })).rejects.toThrow(
      'agentmetrics',
    );
    expect(service.getMetrics().usage).toHaveLength(0);
  });

  it('supports a quota-only unavailable observation without fabricating usage', async () => {
    const service = new FleetControlService();
    const result = await new TelemetryIngestor(service).ingest({
      quota: quota({
        snapshotId: 'quota-unknown-1',
        availability: 'unavailable',
        confidence: 'unknown',
        remaining: undefined,
      }),
    });

    expect(result.response.decision).toBe('accepted');
    expect(service.getMetrics()).toMatchObject({
      usage: [],
      quotas: [
        expect.objectContaining({ snapshotId: 'quota-unknown-1', availability: 'unavailable' }),
      ],
    });
  });
});
