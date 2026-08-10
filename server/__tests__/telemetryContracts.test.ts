import { describe, expect, it } from 'vitest';

import type { QuotaSnapshot } from '../../core/src/ledgerContracts.js';
import {
  collectTelemetryReport,
  telemetryEnvelopeFromCollectorReport,
} from '../src/telemetryContracts.js';

const context = {
  usageId: 'usage-contract-1',
  instanceId: 'agent-1',
  sessionId: 'session-1',
  missionId: 'mission-1',
  workItemId: 'work-1',
  runtime: 'codex-cli' as const,
  modelId: 'gpt-5.3-codex',
  capturedAt: 1_700_000_000_000,
};

const quota: QuotaSnapshot = {
  snapshotId: 'quota-contract-1',
  runtime: 'codex-cli',
  window: 'daily',
  capturedAt: context.capturedAt,
  remaining: { amount: 90, unit: 'requests' },
  source: 'agentmetrics',
  availability: 'available',
  confidence: 'high',
  estimateOrActual: 'actual',
};

describe('telemetry collector contracts', () => {
  it('collects usage, duration, cost and quota independently and projects them safely', async () => {
    const report = await collectTelemetryReport(
      {
        usage: {
          kind: 'usage',
          collect: async () => ({
            kind: 'usage',
            source: 'agentmetrics',
            availability: 'available',
            confidence: 'exact',
            estimateOrActual: 'actual',
            capturedAt: context.capturedAt,
            value: { tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          }),
        },
        duration: {
          kind: 'duration',
          collect: async () => ({
            kind: 'duration',
            source: 'agentmetrics',
            availability: 'available',
            confidence: 'exact',
            estimateOrActual: 'actual',
            capturedAt: context.capturedAt,
            value: 1_200,
          }),
        },
        cost: {
          kind: 'cost',
          collect: async () => ({
            kind: 'cost',
            source: 'agentmetrics',
            availability: 'available',
            confidence: 'high',
            estimateOrActual: 'estimate',
            capturedAt: context.capturedAt,
            value: { amount: 0.12, currency: 'USD', basis: 'api-equivalent' },
          }),
        },
        quota: {
          kind: 'quota',
          collect: async () => ({
            kind: 'quota',
            source: 'agentmetrics',
            availability: 'available',
            confidence: 'high',
            estimateOrActual: 'actual',
            capturedAt: context.capturedAt,
            value: quota,
          }),
        },
      },
      context,
    );

    const envelope = telemetryEnvelopeFromCollectorReport(report, context);
    expect(envelope.usage).toMatchObject({
      usageId: 'usage-contract-1',
      durationMs: 1_200,
      cost: { amount: 0.12, basis: 'api-equivalent' },
      estimateOrActual: 'estimate',
    });
    expect(envelope.quota).toEqual(quota);
  });

  it('keeps missing and failed collectors explicitly unavailable', async () => {
    const report = await collectTelemetryReport(
      {
        usage: {
          kind: 'usage',
          collect: async () => {
            throw new Error('authorization=Bearer secret-token');
          },
        },
      },
      context,
    );

    expect(report.usage).toMatchObject({ availability: 'unavailable', confidence: 'unknown' });
    expect(report.usage.reason).not.toContain('secret-token');
    expect(report.duration.availability).toBe('unavailable');
    expect(report.cost.availability).toBe('unavailable');
    expect(report.quota.availability).toBe('unavailable');

    const envelope = telemetryEnvelopeFromCollectorReport(report, context);
    expect(envelope.usage).toBeUndefined();
    expect(envelope.quota).toMatchObject({ availability: 'unavailable', confidence: 'unknown' });
  });

  it('rejects a value attached to an unavailable observation', async () => {
    await expect(
      collectTelemetryReport(
        {
          duration: {
            kind: 'duration',
            collect: async () => ({
              kind: 'duration',
              source: 'agentmetrics',
              availability: 'unavailable',
              confidence: 'unknown',
              estimateOrActual: 'actual',
              capturedAt: context.capturedAt,
              value: 0,
            }),
          },
        },
        context,
      ),
    ).resolves.toMatchObject({ duration: { availability: 'unavailable' } });
  });

  it('rejects unsupported observation fields before they reach ingestion', async () => {
    const report = await collectTelemetryReport(
      {
        usage: {
          kind: 'usage',
          collect: async () => ({
            kind: 'usage',
            source: 'agentmetrics',
            availability: 'available',
            confidence: 'exact',
            estimateOrActual: 'actual',
            capturedAt: context.capturedAt,
            value: { tokens: { totalTokens: 1 } },
            transcript: 'must not cross the boundary',
          }),
        } as never,
      },
      context,
    );

    expect(report.usage.availability).toBe('unavailable');
    expect(report.usage.reason).not.toContain('must not cross');
  });
});
