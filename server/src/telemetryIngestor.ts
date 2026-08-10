import { createHash } from 'node:crypto';

import type {
  FleetControlRequest,
  FleetControlResponse,
  FleetMetricsSnapshot,
} from '../../core/src/controlContracts.js';
import type {
  QuotaSnapshot,
  TokenUsage,
  UsageAggregation,
  UsageCostBreakdown,
  UsageRecord,
} from '../../core/src/ledgerContracts.js';
import { validateLedgerPayload } from '../../core/src/ledgerContracts.js';
import type { FleetControlMode, FleetRuntime } from '../../core/src/runtimeContracts.js';

/**
 * The only server-side input accepted from agentmetrics.
 *
 * `unknown` is intentional: JSON from an external collector must be validated
 * before it is allowed to cross into FleetControlService.
 */
export interface TelemetryIngestEnvelope {
  usage?: unknown;
  quota?: unknown;
  idempotencyKey?: string;
  requestId?: string;
  requestedBy?: string;
  mode?: FleetControlMode;
  createdAt?: number;
}

export interface TelemetryControlBoundary {
  submit(request: FleetControlRequest): Promise<FleetControlResponse>;
  getMetrics(instanceId?: string): FleetMetricsSnapshot | Promise<FleetMetricsSnapshot>;
}

export interface TelemetryIngestResult {
  response: FleetControlResponse;
  requestId: string;
  deduplicated: boolean;
}

export class TelemetryIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryIngestError';
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|rk|ghp|github_pat|xoxb|xapp|AIza)[-_][A-Za-z0-9._-]+)/i;
const ROOT_KEYS = new Set([
  'usage',
  'quota',
  'idempotencyKey',
  'requestId',
  'requestedBy',
  'mode',
  'createdAt',
]);
const USAGE_KEYS = new Set([
  'usageId',
  'instanceId',
  'sessionId',
  'missionId',
  'workItemId',
  'resourceAccountId',
  'runtime',
  'providerDisplayName',
  'modelId',
  'capturedAt',
  'turnId',
  'aggregation',
  'durationMs',
  'tokens',
  'cost',
  'costs',
  'quotaImpact',
  'source',
  'availability',
  'confidence',
  'estimateOrActual',
]);
const QUOTA_KEYS = new Set([
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

type NormalizedTelemetry = {
  usage?: UsageRecord;
  quota: QuotaSnapshot;
  idempotencyKey: string;
  requestId: string;
  requestedBy: string;
  mode: FleetControlMode;
  createdAt: number;
  fingerprint: string;
};

type SeenRecord = {
  fingerprint: string;
  response: FleetControlResponse;
};

/**
 * Explicit, secret-free adapter from normalized agentmetrics JSON to the
 * FleetControlService `record_telemetry` request boundary.
 */
export class TelemetryIngestor {
  private readonly seen = new Map<string, SeenRecord>();
  private readonly now: () => number;

  constructor(
    private readonly control: TelemetryControlBoundary,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async ingest(input: TelemetryIngestEnvelope): Promise<TelemetryIngestResult> {
    const normalized = await this.normalize(input);
    const prior = this.seen.get(normalized.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== normalized.fingerprint) {
        throw new TelemetryIngestError(
          'Idempotency key was reused for a different telemetry payload.',
        );
      }
      return {
        response: clone(prior.response),
        requestId: normalized.requestId,
        deduplicated: true,
      };
    }

    const existing = await this.findExisting(normalized);
    const response = await this.control.submit({
      requestId: normalized.requestId,
      action: 'record_telemetry',
      mode: normalized.mode,
      requestedBy: normalized.requestedBy,
      telemetry: {
        ...(normalized.usage ? { usage: normalized.usage } : {}),
        quota: normalized.quota,
      },
      createdAt: normalized.createdAt,
    });

    if (response.decision === 'accepted') {
      this.seen.set(normalized.idempotencyKey, {
        fingerprint: normalized.fingerprint,
        response: clone(response),
      });
    }

    return {
      response: clone(response),
      requestId: normalized.requestId,
      deduplicated: existing,
    };
  }

  private async normalize(input: TelemetryIngestEnvelope): Promise<NormalizedTelemetry> {
    const root = record(input, 'telemetry envelope');
    rejectForbiddenFields(root);
    rejectUnknownKeys(root, ROOT_KEYS, 'telemetry envelope');

    const usage = root.usage === undefined ? undefined : normalizeUsage(root.usage);
    const quota =
      root.quota === undefined || root.quota === null
        ? unavailableQuota(usage, this.now())
        : normalizeQuota(root.quota);

    if (!usage && !root.quota) {
      throw new TelemetryIngestError('Telemetry requires a normalized usage or quota record.');
    }

    const idempotencyKey = root.idempotencyKey
      ? safeText(root.idempotencyKey, 'idempotencyKey', 128)
      : `usage:${usage?.usageId ?? '-'}|quota:${quota.snapshotId}`;
    const requestId = root.requestId
      ? safeId(root.requestId, 'requestId')
      : `telemetry-${sha256(idempotencyKey).slice(0, 32)}`;
    const requestedBy = root.requestedBy ? safeId(root.requestedBy, 'requestedBy') : 'agentmetrics';
    const mode = root.mode ?? 'approve';
    if (!['observe', 'suggest', 'approve', 'autonomous'].includes(mode)) {
      throw new TelemetryIngestError('mode must be a supported Fleet control mode.');
    }
    const createdAt = root.createdAt ?? this.now();
    finiteNonNegative(createdAt, 'createdAt');

    const fingerprint = stableStringify({ usage, quota });
    return {
      usage,
      quota,
      idempotencyKey,
      requestId,
      requestedBy,
      mode,
      createdAt,
      fingerprint,
    };
  }

  /**
   * Ledger IDs are the durable idempotency boundary. This check also works
   * after an ingestor object is recreated over a persisted Fleet ledger.
   */
  private async findExisting(input: NormalizedTelemetry): Promise<boolean> {
    const metrics = await this.control.getMetrics();
    const existingUsage = input.usage
      ? metrics.usage.find((record) => record.usageId === input.usage?.usageId)
      : undefined;
    if (existingUsage && stableStringify(existingUsage) !== stableStringify(input.usage)) {
      throw new TelemetryIngestError('usageId already exists with different telemetry.');
    }

    const existingQuota = metrics.quotas.find(
      (record) => record.snapshotId === input.quota.snapshotId,
    );
    if (existingQuota && stableStringify(existingQuota) !== stableStringify(input.quota)) {
      throw new TelemetryIngestError('snapshotId already exists with different quota telemetry.');
    }
    return Boolean(existingUsage || existingQuota);
  }
}

function normalizeUsage(value: unknown): UsageRecord {
  const input = record(value, 'usage');
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, USAGE_KEYS, 'usage');
  if (input.source !== 'agentmetrics') {
    throw new TelemetryIngestError('usage.source must be agentmetrics.');
  }

  const usageId = safeId(input.usageId, 'usage.usageId');
  const result: UsageRecord = {
    usageId,
    capturedAt: positiveFinite(input.capturedAt, 'usage.capturedAt'),
    source: 'agentmetrics',
    availability: enumValue(
      input.availability,
      ['available', 'partial', 'unavailable'],
      'usage.availability',
    ),
    confidence: enumValue(
      input.confidence,
      ['exact', 'high', 'medium', 'low', 'unknown'],
      'usage.confidence',
    ),
    estimateOrActual: enumValue(
      input.estimateOrActual,
      ['estimate', 'actual'],
      'usage.estimateOrActual',
    ),
  };

  for (const field of [
    'instanceId',
    'sessionId',
    'missionId',
    'workItemId',
    'resourceAccountId',
  ] as const) {
    if (input[field] !== undefined) result[field] = safeId(input[field], `usage.${field}`);
  }
  if (input.turnId !== undefined) result.turnId = safeId(input.turnId, 'usage.turnId');
  if (input.runtime !== undefined) result.runtime = runtime(input.runtime, 'usage.runtime');
  if (input.providerDisplayName !== undefined)
    result.providerDisplayName = safeText(
      input.providerDisplayName,
      'usage.providerDisplayName',
      256,
    );
  if (input.modelId !== undefined) result.modelId = safeText(input.modelId, 'usage.modelId', 256);
  if (input.aggregation !== undefined) {
    result.aggregation = enumValue(
      input.aggregation,
      ['turn', 'session-cumulative', 'session-segment'],
      'usage.aggregation',
    ) as UsageAggregation;
  }
  if (input.durationMs !== undefined)
    result.durationMs = nonNegativeInteger(input.durationMs, 'usage.durationMs');
  if (input.tokens !== undefined) result.tokens = normalizeTokens(input.tokens);
  if (input.cost !== undefined) result.cost = normalizeCost(input.cost);
  if (input.costs !== undefined) result.costs = normalizeCosts(input.costs);
  if (input.quotaImpact !== undefined) result.quotaImpact = normalizeQuotaImpact(input.quotaImpact);
  return result;
}

function normalizeQuota(value: unknown): QuotaSnapshot {
  const input = record(value, 'quota');
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, QUOTA_KEYS, 'quota');
  if (input.source !== 'agentmetrics') {
    throw new TelemetryIngestError('quota.source must be agentmetrics.');
  }

  const availability = enumValue(
    input.availability,
    ['available', 'partial', 'unavailable'],
    'quota.availability',
  );
  const result: QuotaSnapshot = {
    snapshotId: safeId(input.snapshotId, 'quota.snapshotId'),
    window: enumValue(
      input.window,
      ['session', 'five-hour', 'daily', 'weekly', 'monthly', 'custom'],
      'quota.window',
    ),
    capturedAt: positiveFinite(input.capturedAt, 'quota.capturedAt'),
    source: 'agentmetrics',
    availability,
    confidence: enumValue(
      input.confidence,
      ['exact', 'high', 'medium', 'low', 'unknown'],
      'quota.confidence',
    ),
    estimateOrActual: enumValue(
      input.estimateOrActual,
      ['estimate', 'actual'],
      'quota.estimateOrActual',
    ),
  };

  for (const field of ['resourceAccountId'] as const) {
    if (input[field] !== undefined) result[field] = safeId(input[field], `quota.${field}`);
  }
  if (input.runtime !== undefined) result.runtime = runtime(input.runtime, 'quota.runtime');
  if (input.providerDisplayName !== undefined)
    result.providerDisplayName = safeText(
      input.providerDisplayName,
      'quota.providerDisplayName',
      256,
    );
  if (input.planType !== undefined)
    result.planType = safeText(input.planType, 'quota.planType', 128);
  if (input.billingMode !== undefined) {
    result.billingMode = enumValue(
      input.billingMode,
      ['metered', 'subscription', 'credits', 'unknown'],
      'quota.billingMode',
    ) as NonNullable<QuotaSnapshot['billingMode']>;
  }
  if (input.limit !== undefined) result.limit = normalizeQuotaValue(input.limit, 'quota.limit');
  if (input.used !== undefined) result.used = normalizeQuotaValue(input.used, 'quota.used');
  if (input.remaining !== undefined)
    result.remaining = normalizeQuotaValue(input.remaining, 'quota.remaining');
  if (input.resetsAt !== undefined)
    result.resetsAt = positiveFinite(input.resetsAt, 'quota.resetsAt');

  if (
    availability === 'unavailable' &&
    (result.limit !== undefined || result.used !== undefined || result.remaining !== undefined)
  ) {
    throw new TelemetryIngestError('Unavailable quota must not contain numeric quota evidence.');
  }
  return result;
}

function unavailableQuota(usage: UsageRecord | undefined, capturedAt: number): QuotaSnapshot {
  return {
    snapshotId: `quota-${usage?.usageId ?? 'unknown'}`,
    ...(usage?.instanceId ? { runtime: usage.runtime } : {}),
    window: 'session',
    capturedAt: usage?.capturedAt ?? capturedAt,
    source: 'agentmetrics',
    availability: 'unavailable',
    confidence: 'unknown',
    estimateOrActual: 'actual',
  };
}

function normalizeTokens(value: unknown): TokenUsage {
  const input = record(value, 'usage.tokens');
  rejectForbiddenFields(input);
  const allowed = new Set(['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']);
  rejectUnknownKeys(input, allowed, 'usage.tokens');
  const result: TokenUsage = {};
  for (const field of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'totalTokens',
  ] as const) {
    if (input[field] !== undefined)
      result[field] = nonNegativeInteger(input[field], `usage.tokens.${field}`);
  }
  return result;
}

function normalizeCost(value: unknown): NonNullable<UsageRecord['cost']> {
  const input = record(value, 'usage.cost');
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, new Set(['amount', 'currency', 'basis']), 'usage.cost');
  return {
    amount: finiteNonNegative(input.amount, 'usage.cost.amount'),
    currency: safeText(input.currency, 'usage.cost.currency', 16),
    basis: enumValue(
      input.basis,
      ['metered', 'api-equivalent', 'subscription-amortized', 'unknown'],
      'usage.cost.basis',
    ),
  };
}

function normalizeCosts(value: unknown): UsageCostBreakdown {
  const input = record(value, 'usage.costs');
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, new Set(['apiEquivalent', 'metered', 'subscription']), 'usage.costs');
  const result: UsageCostBreakdown = {};
  if (input.apiEquivalent !== undefined) {
    result.apiEquivalent = normalizeCostWithBasis(
      input.apiEquivalent,
      'api-equivalent',
      'usage.costs.apiEquivalent',
    );
  }
  if (input.metered !== undefined) {
    result.metered = normalizeCostWithBasis(input.metered, 'metered', 'usage.costs.metered');
  }
  if (input.subscription !== undefined) {
    const subscription = record(input.subscription, 'usage.costs.subscription');
    rejectForbiddenFields(subscription);
    rejectUnknownKeys(
      subscription,
      new Set([
        'amount',
        'currency',
        'basis',
        'planType',
        'billingPeriod',
        'periodPrice',
        'priceSource',
        'fractionOfPeriod',
        'consumedPercentage',
        'resourceAccountId',
        'confidence',
        'availability',
        'estimateOrActual',
      ]),
      'usage.costs.subscription',
    );
    result.subscription = {
      amount: finiteNonNegative(subscription.amount, 'usage.costs.subscription.amount'),
      currency: safeText(subscription.currency, 'usage.costs.subscription.currency', 16),
      basis: enumValue(
        subscription.basis,
        ['subscription-amortized'],
        'usage.costs.subscription.basis',
      ) as 'subscription-amortized',
      ...(subscription.planType === undefined
        ? {}
        : { planType: safeText(subscription.planType, 'usage.costs.subscription.planType', 128) }),
      billingPeriod: enumValue(
        subscription.billingPeriod,
        ['five-hour', 'daily', 'weekly', 'monthly', 'yearly', 'custom'],
        'usage.costs.subscription.billingPeriod',
      ),
      periodPrice: finiteNonNegative(
        subscription.periodPrice,
        'usage.costs.subscription.periodPrice',
      ),
      priceSource: enumValue(
        subscription.priceSource,
        ['official-list', 'user-entered', 'invoice', 'provider', 'unknown'],
        'usage.costs.subscription.priceSource',
      ),
      fractionOfPeriod: boundedFraction(
        subscription.fractionOfPeriod,
        'usage.costs.subscription.fractionOfPeriod',
      ),
      consumedPercentage: boundedPercentage(
        subscription.consumedPercentage,
        'usage.costs.subscription.consumedPercentage',
      ),
      ...(subscription.resourceAccountId === undefined
        ? {}
        : {
            resourceAccountId: safeId(
              subscription.resourceAccountId,
              'usage.costs.subscription.resourceAccountId',
            ),
          }),
      confidence: enumValue(
        subscription.confidence,
        ['exact', 'high', 'medium', 'low', 'unknown'],
        'usage.costs.subscription.confidence',
      ),
      availability: enumValue(
        subscription.availability,
        ['available', 'partial', 'unavailable'],
        'usage.costs.subscription.availability',
      ),
      estimateOrActual: enumValue(
        subscription.estimateOrActual,
        ['estimate', 'actual'],
        'usage.costs.subscription.estimateOrActual',
      ),
    };
  }
  return result;
}

function normalizeCostWithBasis(
  value: unknown,
  basis: 'metered' | 'api-equivalent',
  field: string,
): NonNullable<UsageCostBreakdown['apiEquivalent']> {
  const input = record(value, field);
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, new Set(['amount', 'currency', 'basis']), field);
  const declaredBasis = enumValue(input.basis, [basis], `${field}.basis`);
  return {
    amount: finiteNonNegative(input.amount, `${field}.amount`),
    currency: safeText(input.currency, `${field}.currency`, 16),
    basis: declaredBasis,
  };
}

function normalizeQuotaImpact(value: unknown): NonNullable<UsageRecord['quotaImpact']> {
  const input = record(value, 'usage.quotaImpact');
  rejectForbiddenFields(input);
  rejectUnknownKeys(
    input,
    new Set([
      'resourceAccountId',
      'planType',
      'billingMode',
      'window',
      'consumedPercentage',
      'fractionOfWindow',
      'before',
      'after',
      'source',
      'availability',
      'confidence',
      'estimateOrActual',
    ]),
    'usage.quotaImpact',
  );
  return {
    ...(input.resourceAccountId === undefined
      ? {}
      : {
          resourceAccountId: safeId(input.resourceAccountId, 'usage.quotaImpact.resourceAccountId'),
        }),
    ...(input.planType === undefined
      ? {}
      : { planType: safeText(input.planType, 'usage.quotaImpact.planType', 128) }),
    ...(input.billingMode === undefined
      ? {}
      : {
          billingMode: enumValue(
            input.billingMode,
            ['metered', 'subscription', 'credits', 'unknown'],
            'usage.quotaImpact.billingMode',
          ) as NonNullable<NonNullable<UsageRecord['quotaImpact']>['billingMode']>,
        }),
    window: enumValue(
      input.window,
      ['session', 'five-hour', 'daily', 'weekly', 'monthly', 'custom'],
      'usage.quotaImpact.window',
    ),
    ...(input.consumedPercentage === undefined
      ? {}
      : {
          consumedPercentage: boundedPercentage(
            input.consumedPercentage,
            'usage.quotaImpact.consumedPercentage',
          ),
        }),
    ...(input.fractionOfWindow === undefined
      ? {}
      : {
          fractionOfWindow: boundedFraction(
            input.fractionOfWindow,
            'usage.quotaImpact.fractionOfWindow',
          ),
        }),
    ...(input.before === undefined
      ? {}
      : { before: normalizeQuotaValue(input.before, 'usage.quotaImpact.before') }),
    ...(input.after === undefined
      ? {}
      : { after: normalizeQuotaValue(input.after, 'usage.quotaImpact.after') }),
    source: enumValue(
      input.source,
      ['runtime', 'telemetry', 'provider', 'resource', 'agentmetrics', 'system', 'external'],
      'usage.quotaImpact.source',
    ),
    availability: enumValue(
      input.availability,
      ['available', 'partial', 'unavailable'],
      'usage.quotaImpact.availability',
    ),
    confidence: enumValue(
      input.confidence,
      ['exact', 'high', 'medium', 'low', 'unknown'],
      'usage.quotaImpact.confidence',
    ),
    estimateOrActual: enumValue(
      input.estimateOrActual,
      ['estimate', 'actual'],
      'usage.quotaImpact.estimateOrActual',
    ),
  };
}

function normalizeQuotaValue(
  value: unknown,
  field: string,
): NonNullable<QuotaSnapshot['remaining']> {
  const input = record(value, field);
  rejectForbiddenFields(input);
  rejectUnknownKeys(input, new Set(['amount', 'unit']), field);
  return {
    amount: finiteNonNegative(input.amount, `${field}.amount`),
    unit: enumValue(input.unit, ['tokens', 'credits', 'currency', 'requests'], `${field}.unit`),
  };
}

function boundedPercentage(value: unknown, field: string): number {
  const result = finiteNonNegative(value, field);
  if (result > 100) throw new TelemetryIngestError(`${field} must be between 0 and 100.`);
  return result;
}

function boundedFraction(value: unknown, field: string): number {
  const result = finiteNonNegative(value, field);
  if (result > 1) throw new TelemetryIngestError(`${field} must be between 0 and 1.`);
  return result;
}

function record(value: unknown, field: string): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TelemetryIngestError(`${field} must be a JSON object.`);
  }
  return value as Record<string, any>;
}

function rejectForbiddenFields(value: unknown): void {
  const errors = validateLedgerPayload(value);
  if (errors.length > 0) throw new TelemetryIngestError(errors[0]);
  const visit = (current: unknown): void => {
    if (typeof current === 'string' && SECRET_VALUE.test(current)) {
      throw new TelemetryIngestError('Telemetry contains a secret-like value.');
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
}

function rejectUnknownKeys(value: Record<string, any>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TelemetryIngestError(`${field} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TelemetryIngestError(`${field} must be a safe non-empty identifier.`);
  }
  return value;
}

function safeText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    SECRET_VALUE.test(value)
  ) {
    throw new TelemetryIngestError(`${field} must be bounded, non-secret text.`);
  }
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TelemetryIngestError(`${field} must be a non-negative finite number.`);
  }
  return value;
}

function positiveFinite(value: unknown, field: string): number {
  const result = finiteNonNegative(value, field);
  if (result <= 0) throw new TelemetryIngestError(`${field} must be positive.`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = finiteNonNegative(value, field);
  if (!Number.isInteger(result)) throw new TelemetryIngestError(`${field} must be an integer.`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TelemetryIngestError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function runtime(value: unknown, field: string): FleetRuntime {
  if (value === 'claude-code' || value === 'codex-cli') return value;
  if (value === 'other') return 'other';
  if (typeof value === 'string' && value.trim()) return 'other';
  throw new TelemetryIngestError(`${field} must identify a runtime.`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => JSON.stringify(key) + ':' + stableStringify(child));
  return '{' + entries.join(',') + '}';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
