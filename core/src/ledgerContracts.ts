/**
 * Fleet Ledger contracts.
 *
 * These contracts describe durable metadata only. They do not define storage,
 * scheduling, runtime execution, or transcript transport.
 */

import type { AgentRole, FleetControlMode, FleetRuntime, FleetStatus } from './runtimeContracts.js';

export type LedgerSource =
  | 'runtime'
  | 'telemetry'
  | 'provider'
  | 'resource'
  | 'scm'
  | 'strategy'
  | 'ledger'
  | 'user'
  | 'system'
  | 'external';

export type DataAvailability = 'available' | 'partial' | 'unavailable';
export type EvidenceConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown';
export type EstimateOrActual = 'estimate' | 'actual';

export interface LedgerEvidence {
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
  observedAt?: number;
}

export interface LedgerMeasurement<T> extends LedgerEvidence {
  value: T;
}

export interface ExpectedActual<T> {
  expected?: LedgerMeasurement<T>;
  actual?: LedgerMeasurement<T>;
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type CostBasis = 'metered' | 'api-equivalent' | 'unknown';

export interface CostAmount {
  amount: number;
  currency: string;
  basis: CostBasis;
}

export type QuotaUnit = 'tokens' | 'credits' | 'currency' | 'requests';

export interface QuotaValue {
  amount: number;
  unit: QuotaUnit;
}

export type QuotaWindow = 'session' | 'five-hour' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface QuotaSnapshot {
  snapshotId: string;
  resourceAccountId?: string;
  runtime?: FleetRuntime;
  providerDisplayName?: string;
  window: QuotaWindow;
  capturedAt: number;
  limit?: QuotaValue;
  used?: QuotaValue;
  remaining?: QuotaValue;
  resetsAt?: number;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export interface ResourceMetrics {
  durationMs?: number;
  tokens?: TokenUsage;
  cost?: CostAmount;
  quotaImpact?: QuotaValue;
}

export type ExpectedActualMetrics = ExpectedActual<ResourceMetrics>;

export type MissionStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type WorkItemStatus =
  'queued' | 'assigned' | 'active' | 'blocked' | 'review' | 'completed' | 'cancelled';

export interface MissionRecord {
  missionId: string;
  title: string;
  objective: string;
  status: MissionStatus;
  coordinatorId?: string;
  repoScope?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metrics?: ExpectedActualMetrics;
}

export interface WorkItemRecord {
  workItemId: string;
  missionId: string;
  title: string;
  objective: string;
  status: WorkItemStatus;
  acceptanceCriteria: string[];
  dependencyIds?: string[];
  repo?: string;
  worktree?: string;
  assignedInstanceId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metrics?: ExpectedActualMetrics;
}

export type SessionStatus = 'starting' | 'active' | 'waiting' | 'completed' | 'stopped' | 'error';

export interface SessionRecord {
  sessionId: string;
  instanceId: string;
  runtime: FleetRuntime;
  managedByFleet: boolean;
  missionId?: string;
  workItemId?: string;
  hostId?: string;
  workspaceId?: string;
  workspacePath?: string;
  repo?: string;
  worktree?: string;
  terminalId?: string;
  terminalName?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  status: SessionStatus;
  launchSource?: string;
  requestedBy?: string;
  startedAt: number;
  endedAt?: number;
  metrics?: ExpectedActualMetrics;
}

export type LaunchSource =
  | 'fleet-control-api'
  | 'vscode-command'
  | 'auto-discovery'
  | 'user-terminal'
  | 'external'
  | 'unknown';

export type SessionMode = 'new' | 'resume';

export interface LaunchRecord {
  launchId: string;
  instanceId: string;
  sessionId?: string;
  runtime: FleetRuntime;
  managedByFleet: boolean;
  hostId?: string;
  workspaceId?: string;
  workspacePath?: string;
  repo?: string;
  worktree?: string;
  terminalId?: string;
  terminalName?: string;
  launchSource: LaunchSource;
  requestedBy?: string;
  sessionMode: SessionMode;
  result: 'requested' | 'started' | 'failed' | 'stopped';
  createdAt: number;
  completedAt?: number;
  error?: {
    message: string;
    source: LedgerSource;
    observedAt: number;
  };
  metrics?: ExpectedActualMetrics;
}

export interface ControlDecisionRecord {
  decisionId: string;
  requestId: string;
  action: string;
  decision: 'accepted' | 'approval_required' | 'rejected' | 'unavailable';
  mode: FleetControlMode;
  requestedBy: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  runtime?: FleetRuntime;
  reason?: string;
  createdAt: number;
  completedAt?: number;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export interface UsageRecord {
  usageId: string;
  instanceId?: string;
  sessionId?: string;
  missionId?: string;
  workItemId?: string;
  resourceAccountId?: string;
  runtime?: FleetRuntime;
  providerDisplayName?: string;
  modelId?: string;
  capturedAt: number;
  durationMs?: number;
  tokens?: TokenUsage;
  cost?: CostAmount;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export type QualitySignalKind = 'test' | 'review' | 'build' | 'lint' | 'merge' | 'user' | 'runtime';

export interface QualitySignal {
  signalId: string;
  kind: QualitySignalKind;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  pullRequestId?: string;
  outcome: 'passed' | 'failed' | 'warning' | 'neutral';
  score?: number;
  summary?: string;
  capturedAt: number;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export interface LaunchTemplate {
  runtime: FleetRuntime;
  role: AgentRole;
  hostId?: string;
  workspaceId?: string;
  workspacePath?: string;
  repo?: string;
  worktree?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  terminalName?: string;
  requestedBy?: string;
}

export type AssignmentAction = 'assign_existing' | 'launch_new' | 'defer' | 'escalate';
export type AssignmentApproval = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface AssignmentDecision {
  decisionId: string;
  missionId: string;
  workItemId: string;
  action: AssignmentAction;
  candidateInstanceIds: string[];
  selectedInstanceId?: string;
  launchTemplate?: LaunchTemplate;
  policyMode: FleetControlMode;
  approval: AssignmentApproval;
  strategyVersion: string;
  rationale?: string;
  createdAt: number;
  decidedAt?: number;
  expected?: LedgerMeasurement<ResourceMetrics>;
  actual?: LedgerMeasurement<ResourceMetrics>;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export interface AgentPerformanceAggregate {
  aggregateId: string;
  instanceId?: string;
  runtime: FleetRuntime;
  role: AgentRole;
  windowStartedAt: number;
  windowEndedAt: number;
  sampleCount: number;
  completedWorkItems: number;
  successRate?: number;
  qualityScore?: number;
  averageDurationMs?: number;
  averageTokensPerWorkItem?: number;
  averageCostPerWorkItem?: CostAmount;
  strategyAccuracy?: number;
  status?: FleetStatus;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  estimateOrActual: EstimateOrActual;
}

export type ResourceAccountKind = 'subscription' | 'api' | 'cloud' | 'local' | 'custom';

export interface ResourceAccount {
  resourceAccountId: string;
  kind: ResourceAccountKind;
  displayName: string;
  providerDisplayName?: string;
  runtime?: FleetRuntime;
  quotaScopes?: string[];
  enabled: boolean;
  source: LedgerSource;
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  lastObservedAt?: number;
}

export type SafeMetadataPrimitive = string | number | boolean | null;
export type SafeMetadataValue =
  SafeMetadataPrimitive | SafeMetadataValue[] | { readonly [key: string]: SafeMetadataValue };
export type SafeMetadata = Readonly<Record<string, SafeMetadataValue>>;

const FORBIDDEN_LEDGER_KEY =
  /(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|secret|private[-_]?key|credential|transcript|raw[-_]?(?:prompt|event|output)|environment)/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSafeValue(value: unknown, seen: WeakSet<object>): SafeMetadataValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return undefined;
    }
    return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').slice(0, 500) : value;
  }

  if (!isObject(value) || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeSafeValue(item, seen))
      .filter((item): item is SafeMetadataValue => item !== undefined);
    return items;
  }

  const result: Record<string, SafeMetadataValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_LEDGER_KEY.test(key)) {
      continue;
    }

    const normalized = normalizeSafeValue(child, seen);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }

  return result;
}

/**
 * Keep only bounded, JSON-like metadata and omit secrets, auth material,
 * environment snapshots, transcripts, and raw event payloads.
 */
export function normalizeSafeMetadata(input: unknown): SafeMetadata {
  if (!isObject(input) || Array.isArray(input)) {
    return {};
  }

  const normalized = normalizeSafeValue(input, new WeakSet<object>());
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : {};
}

/**
 * Validate an arbitrary ledger payload before persistence or transport.
 * This detects forbidden fields instead of guessing or storing their values.
 */
export function validateLedgerPayload(input: unknown): string[] {
  const errors: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (!isObject(value)) {
      return;
    }

    if (seen.has(value)) {
      errors.push(path + ': cyclic data is not supported');
      return;
    }

    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      const childPath = path + '.' + key;
      if (FORBIDDEN_LEDGER_KEY.test(key)) {
        errors.push(childPath + ': forbidden secret, auth, environment, or transcript field');
        continue;
      }
      visit(child, childPath);
    }
  };

  visit(input, 'record');
  return errors;
}

export function isLedgerPayloadSafe(input: unknown): boolean {
  return validateLedgerPayload(input).length === 0;
}
