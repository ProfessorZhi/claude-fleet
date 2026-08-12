import type {
  CostAmount,
  DataAvailability,
  EstimateOrActual,
  EvidenceConfidence,
  QuotaSnapshot,
  TokenUsage,
  UsageRecord,
} from '../../core/src/ledgerContracts.js';
import type { FleetRuntime } from '../../core/src/runtimeContracts.js';
import type { TelemetryIngestEnvelope } from './telemetryIngestor.js';

export type TelemetryMetricKind = 'usage' | 'duration' | 'cost' | 'quota';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|rk|ghp|github_pat|xoxb|xapp|AIza)[-_][A-Za-z0-9._-]+)/i;

export interface TelemetryCollectorContext {
  usageId: string;
  instanceId?: string;
  sessionId?: string;
  missionId?: string;
  workItemId?: string;
  resourceAccountId?: string;
  runtime?: FleetRuntime;
  providerDisplayName?: string;
  modelId?: string;
  turnId?: string;
  aggregation?: 'turn' | 'session-cumulative' | 'session-segment';
  capturedAt: number;
}

export interface CollectorObservation<T> {
  kind: TelemetryMetricKind;
  source: 'agentmetrics';
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
  capturedAt: number;
  value?: T;
  reason?: string;
}

export interface UsageCollectorValue {
  tokens?: TokenUsage;
}

export type DurationCollectorValue = number;
export type CostCollectorValue = CostAmount;
export type QuotaCollectorValue = QuotaSnapshot;

export interface TelemetryCollector<T> {
  readonly kind: TelemetryMetricKind;
  collect(context: TelemetryCollectorContext): Promise<CollectorObservation<T>>;
}

export interface TelemetryCollectorSet {
  usage?: TelemetryCollector<UsageCollectorValue>;
  duration?: TelemetryCollector<DurationCollectorValue>;
  cost?: TelemetryCollector<CostCollectorValue>;
  quota?: TelemetryCollector<QuotaCollectorValue>;
}

export interface TelemetryCollectorReport {
  usage: CollectorObservation<UsageCollectorValue>;
  duration: CollectorObservation<DurationCollectorValue>;
  cost: CollectorObservation<CostCollectorValue>;
  quota: CollectorObservation<QuotaCollectorValue>;
}

/**
 * Run optional collectors independently. A missing or failed collector is a
 * first-class unavailable observation; it never becomes zero or an estimate.
 */
export async function collectTelemetryReport(
  collectors: TelemetryCollectorSet,
  context: TelemetryCollectorContext,
): Promise<TelemetryCollectorReport> {
  validateContext(context);
  const [usage, duration, cost, quota] = await Promise.all([
    collectOne(collectors.usage, context, 'usage'),
    collectOne(collectors.duration, context, 'duration'),
    collectOne(collectors.cost, context, 'cost'),
    collectOne(collectors.quota, context, 'quota'),
  ]);
  return { usage, duration, cost, quota };
}

/**
 * Convert collector observations into the existing TelemetryIngestor input.
 * The ledger has one UsageRecord, so independently observed duration/cost are
 * attached only when they have values. Missing quota is represented explicitly.
 */
export function telemetryEnvelopeFromCollectorReport(
  report: TelemetryCollectorReport,
  context: TelemetryCollectorContext,
): TelemetryIngestEnvelope {
  validateContext(context);
  const supportedReportKeys = new Set(['usage', 'duration', 'cost', 'quota']);
  const unknownReportKeys = Object.keys(report as object).filter(
    (key) => !supportedReportKeys.has(key),
  );
  if (unknownReportKeys.length > 0) {
    throw new Error('collector report contains unsupported fields.');
  }
  const observations = {
    usage: validateObservation(report.usage, 'usage'),
    duration: validateObservation(report.duration, 'duration'),
    cost: validateObservation(report.cost, 'cost'),
    quota: validateObservation(report.quota, 'quota'),
  };

  const hasUsageValue =
    observations.usage.value !== undefined ||
    observations.duration.value !== undefined ||
    observations.cost.value !== undefined;
  const usage = hasUsageValue
    ? buildUsageRecord(context, observations.usage, observations.duration, observations.cost)
    : undefined;
  const quota =
    observations.quota.value ?? unavailableQuota(context, observations.quota.capturedAt);

  return {
    ...(usage ? { usage } : {}),
    quota,
    idempotencyKey: `collector-${context.usageId}`,
    requestId: `telemetry-${context.usageId}`,
    createdAt: context.capturedAt,
  };
}

async function collectOne<T>(
  collector: TelemetryCollector<T> | undefined,
  context: TelemetryCollectorContext,
  kind: TelemetryMetricKind,
): Promise<CollectorObservation<T>> {
  if (!collector) return unavailable(kind, context.capturedAt, `${kind} collector is unavailable.`);
  try {
    const result = await collector.collect(context);
    return validateObservation(result, kind);
  } catch (error) {
    return unavailable(kind, context.capturedAt, safeReason(kind, error));
  }
}

function validateObservation<T>(
  value: CollectorObservation<T>,
  expectedKind: TelemetryMetricKind,
): CollectorObservation<T> {
  if (!value || typeof value !== 'object' || value.kind !== expectedKind) {
    throw new Error(`${expectedKind} collector returned an invalid observation kind.`);
  }
  const supportedKeys = new Set([
    'kind',
    'source',
    'availability',
    'confidence',
    'estimateOrActual',
    'capturedAt',
    'value',
    'reason',
  ]);
  const unknownKeys = Object.keys(value as object).filter((key) => !supportedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${expectedKind} collector observation contains unsupported fields.`);
  }
  if (value.source !== 'agentmetrics') {
    throw new Error(`${expectedKind} collector source must be agentmetrics.`);
  }
  if (!['available', 'partial', 'unavailable'].includes(value.availability)) {
    throw new Error(`${expectedKind} collector returned an invalid availability.`);
  }
  if (!['exact', 'high', 'medium', 'low', 'unknown'].includes(value.confidence)) {
    throw new Error(`${expectedKind} collector returned an invalid confidence.`);
  }
  if (!['estimate', 'actual'].includes(value.estimateOrActual)) {
    throw new Error(`${expectedKind} collector returned an invalid measurement kind.`);
  }
  if (!Number.isFinite(value.capturedAt) || value.capturedAt <= 0) {
    throw new Error(`${expectedKind} collector capturedAt must be non-negative.`);
  }
  if (value.availability === 'unavailable' && value.value !== undefined) {
    throw new Error(`${expectedKind} unavailable observations cannot contain a value.`);
  }
  if (value.reason !== undefined) safeReasonText(value.reason, `${expectedKind}.reason`);
  if (expectedKind === 'duration' && value.value !== undefined) {
    const duration = value.value as unknown;
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0) {
      throw new Error('duration collector value must be a non-negative integer in milliseconds.');
    }
  }
  if (expectedKind === 'cost' && value.value !== undefined) {
    validateCost(value.value as unknown as CostAmount);
  }
  if (expectedKind === 'usage' && value.value !== undefined) {
    validateUsageValue(value.value as unknown as UsageCollectorValue);
  }
  if (expectedKind === 'quota' && value.value !== undefined) {
    validateQuota(value.value as unknown as QuotaSnapshot);
  }
  return value;
}

function buildUsageRecord(
  context: TelemetryCollectorContext,
  usage: CollectorObservation<UsageCollectorValue>,
  duration: CollectorObservation<number>,
  cost: CollectorObservation<CostAmount>,
): UsageRecord {
  const availability = [usage, duration, cost].some((item) => item.availability === 'partial')
    ? 'partial'
    : [usage, duration, cost].every((item) => item.availability === 'available')
      ? 'available'
      : 'partial';
  const confidence = lowestConfidence([usage, duration, cost]);
  const estimateOrActual = [usage, duration, cost].some(
    (item) => item.estimateOrActual === 'estimate',
  )
    ? 'estimate'
    : 'actual';
  const record: UsageRecord = {
    usageId: context.usageId,
    capturedAt: context.capturedAt,
    source: 'agentmetrics',
    availability,
    confidence,
    estimateOrActual,
  };
  for (const field of [
    'instanceId',
    'sessionId',
    'missionId',
    'workItemId',
    'resourceAccountId',
  ] as const) {
    const value = context[field];
    if (value !== undefined) record[field] = value;
  }
  if (context.runtime !== undefined) record.runtime = context.runtime;
  if (context.providerDisplayName !== undefined)
    record.providerDisplayName = context.providerDisplayName;
  if (context.modelId !== undefined) record.modelId = context.modelId;
  if (context.turnId !== undefined) record.turnId = context.turnId;
  if (context.aggregation !== undefined) record.aggregation = context.aggregation;
  if (usage.value?.tokens !== undefined) record.tokens = usage.value.tokens;
  if (duration.value !== undefined) record.durationMs = duration.value;
  if (cost.value !== undefined) record.cost = cost.value;
  return record;
}

function validateUsageValue(value: UsageCollectorValue): void {
  if (!value || typeof value !== 'object')
    throw new Error('usage collector value must be an object.');
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.some((key) => key !== 'tokens')) {
    throw new Error('usage collector value contains unsupported fields.');
  }
  if (value.tokens !== undefined) {
    const supportedTokens = new Set([
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
      'totalTokens',
    ]);
    const unknownTokens = Object.keys(value.tokens).filter((key) => !supportedTokens.has(key));
    if (unknownTokens.length > 0) {
      throw new Error('usage collector tokens contain unsupported fields.');
    }
    for (const token of Object.values(value.tokens)) {
      if (!Number.isInteger(token) || token < 0) {
        throw new Error('usage token values must be non-negative integers.');
      }
    }
  }
}

function validateCost(value: CostAmount): void {
  if (!value || typeof value !== 'object') {
    throw new Error('cost collector value must be an object.');
  }
  const supportedKeys = new Set(['amount', 'currency', 'basis']);
  if (Object.keys(value).some((key) => !supportedKeys.has(key))) {
    throw new Error('cost collector value contains unsupported fields.');
  }
  if (!Number.isFinite(value.amount) || value.amount < 0) {
    throw new Error('cost collector value must contain a non-negative amount.');
  }
  safeTextValue(value.currency, 'cost.currency', 16);
  if (!['metered', 'api-equivalent', 'unknown'].includes(value.basis)) {
    throw new Error('cost collector basis is invalid.');
  }
}

function validateQuota(value: QuotaSnapshot): void {
  if (!value || typeof value !== 'object' || !value.snapshotId || !value.window) {
    throw new Error('quota collector value must be a QuotaSnapshot.');
  }
  const supportedKeys = new Set([
    'snapshotId',
    'resourceAccountId',
    'runtime',
    'providerDisplayName',
    'planType',
    'billingMode',
    'window',
    'capturedAt',
    'limit',
    'used',
    'remaining',
    'resetsAt',
    'source',
    'availability',
    'confidence',
    'estimateOrActual',
  ]);
  if (Object.keys(value).some((key) => !supportedKeys.has(key))) {
    throw new Error('quota collector value contains unsupported fields.');
  }
  safeId(value.snapshotId, 'quota.snapshotId');
  if (value.resourceAccountId !== undefined)
    safeId(value.resourceAccountId, 'quota.resourceAccountId');
  if (value.providerDisplayName !== undefined) {
    safeTextValue(value.providerDisplayName, 'quota.providerDisplayName', 256);
  }
  if (
    value.runtime !== undefined &&
    value.runtime !== 'claude-code' &&
    value.runtime !== 'codex-cli' &&
    value.runtime !== 'other'
  ) {
    throw new Error('quota runtime is invalid.');
  }
  if (!['session', 'five-hour', 'daily', 'weekly', 'monthly', 'custom'].includes(value.window)) {
    throw new Error('quota window is invalid.');
  }
  if (!Number.isFinite(value.capturedAt) || value.capturedAt <= 0) {
    throw new Error('quota capturedAt must be positive.');
  }
  for (const field of ['limit', 'used', 'remaining'] as const) {
    const quotaValue = value[field];
    if (quotaValue !== undefined) {
      if (
        !quotaValue ||
        typeof quotaValue !== 'object' ||
        !Number.isFinite(quotaValue.amount) ||
        quotaValue.amount < 0 ||
        !['tokens', 'credits', 'currency', 'requests'].includes(quotaValue.unit)
      ) {
        throw new Error(`quota.${field} is invalid.`);
      }
    }
  }
  if (value.resetsAt !== undefined && (!Number.isFinite(value.resetsAt) || value.resetsAt <= 0)) {
    throw new Error('quota resetsAt must be positive.');
  }
  if (value.source !== 'agentmetrics') throw new Error('quota source must be agentmetrics.');
  if (value.availability === 'unavailable') {
    if (value.limit || value.used || value.remaining) {
      throw new Error('unavailable quota cannot contain numeric evidence.');
    }
  }
}

function unavailable<T>(
  kind: TelemetryMetricKind,
  capturedAt: number,
  reason: string,
): CollectorObservation<T> {
  return {
    kind,
    source: 'agentmetrics',
    availability: 'unavailable',
    confidence: 'unknown',
    estimateOrActual: 'actual',
    capturedAt,
    reason: safeReasonText(reason, `${kind}.reason`),
  };
}

function unavailableQuota(context: TelemetryCollectorContext, capturedAt: number): QuotaSnapshot {
  return {
    snapshotId: `quota-${context.usageId}`,
    ...(context.resourceAccountId ? { resourceAccountId: context.resourceAccountId } : {}),
    ...(context.runtime ? { runtime: context.runtime } : {}),
    ...(context.providerDisplayName ? { providerDisplayName: context.providerDisplayName } : {}),
    window: 'session',
    capturedAt,
    source: 'agentmetrics',
    availability: 'unavailable',
    confidence: 'unknown',
    estimateOrActual: 'actual',
  };
}

function lowestConfidence(observations: Array<CollectorObservation<unknown>>): EvidenceConfidence {
  const order: EvidenceConfidence[] = ['unknown', 'low', 'medium', 'high', 'exact'];
  return observations.reduce<EvidenceConfidence>(
    (lowest, item) =>
      order.indexOf(item.confidence) < order.indexOf(lowest) ? item.confidence : lowest,
    'exact',
  );
}

function safeReason(kind: TelemetryMetricKind, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return safeReasonText(`${kind} collector unavailable: ${raw}`, `${kind}.reason`);
}

function safeReasonText(value: string, field: string): string {
  const redacted = value
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\b\s*[:=]\s*(?:Bearer\s+)?\S+/gi,
      '[redacted]',
    )
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/(?:diff|patch|prompt|transcript)\b[\s\S]*/gi, '[omitted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 256);
  if (!redacted.trim()) throw new Error(`${field} must be bounded text.`);
  return redacted;
}

function validateContext(context: TelemetryCollectorContext): void {
  safeId(context.usageId, 'usageId');
  for (const [field, value] of Object.entries(context)) {
    if (field === 'capturedAt') continue;
    if (value === undefined) continue;
    if (field.endsWith('Id')) safeId(value, field);
  }
  if (!Number.isFinite(context.capturedAt) || context.capturedAt <= 0) {
    throw new Error('collector context capturedAt must be positive.');
  }
  for (const field of ['providerDisplayName', 'modelId'] as const) {
    const value = context[field];
    if (value !== undefined) safeTextValue(value, `collector context ${field}`, 256);
  }
}

function safeId(value: unknown, field: string): void {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`collector context ${field} must be a safe identifier.`);
  }
}

function safeTextValue(value: unknown, field: string, maxLength: number): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    SECRET_VALUE.test(value)
  ) {
    throw new Error(`${field} must be bounded, non-secret text.`);
  }
}
