/**
 * Runtime-neutral strategy contracts.
 *
 * Strategy evaluates evidence and returns an explainable recommendation. It
 * never launches, stops, or messages a runtime. Side effects remain behind
 * FleetControlApi and an approved RuntimeAdapter/FleetRuntimeHost.
 */

import type { FleetTelemetrySnapshot } from './fleetTelemetry.js';
import type {
  AgentPerformanceAggregate,
  AssignmentAction,
  CostAmount,
  LaunchTemplate,
  LedgerMeasurement,
  QuotaSnapshot,
  QuotaValue,
  ResourceMetrics,
} from './ledgerContracts.js';
import type {
  AgentRole,
  FleetControlMode,
  FleetInstance,
  FleetRuntime,
  WorkItem,
} from './runtimeContracts.js';

export type StrategyObjective =
  | 'balanced'
  | 'throughput'
  | 'quality'
  | 'token-efficiency'
  | 'cost-efficiency'
  | 'quota-utilization';

export interface ResourceDirectiveTarget {
  runtime?: FleetRuntime;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  resourceAccountId?: string;
}

/**
 * A time-bounded optimization hint from the primary Coordinator.
 *
 * A directive can influence ranking, but it cannot bypass policy, invent
 * quota, or execute a runtime operation by itself.
 */
export interface ResourceDirective {
  directiveId: string;
  requestedBy: string;
  target: ResourceDirectiveTarget;
  objective: StrategyObjective;
  priority: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

/** The policy subset needed by strategy evaluation. */
export interface StrategyPolicy {
  mode: FleetControlMode;
  maxConcurrentInstances?: number;
  maxTokenBudget?: number;
  maxCostBudget?: number;
  quotaReserve?: number;
  allowedRuntimeTypes?: FleetRuntime[];
  allowedRoles?: AgentRole[];
  allowedProviderProfileIds?: string[];
  allowedRepositories?: string[];
  requireReview?: boolean;
  requireTests?: boolean;
}

export interface StrategyCandidate {
  instance: FleetInstance;
  telemetry?: FleetTelemetrySnapshot;
  performance?: AgentPerformanceAggregate;
  /** Explicit expected evidence; strategy must not derive quota from tokens. */
  expected?: LedgerMeasurement<ResourceMetrics>;
}

export interface StrategyInput {
  now: number;
  workItem: WorkItem;
  /** Optional when the ControlService can source its current Fleet instances. */
  candidates?: StrategyCandidate[];
  launchTemplates?: LaunchTemplate[];
  quotas?: QuotaSnapshot[];
  policy: StrategyPolicy;
  directive?: ResourceDirective;
  recommendationTtlMs?: number;
}

export type StrategyFactorImpact = 'positive' | 'negative' | 'blocking' | 'neutral';

export interface StrategyFactor {
  key: string;
  impact: StrategyFactorImpact;
  score?: number;
  detail: string;
}

export interface StrategyConstraint {
  key: string;
  blocking: boolean;
  detail: string;
}

export interface StrategyRecommendation {
  recommendationId: string;
  strategyVersion: string;
  missionId: string;
  workItemId: string;
  action: AssignmentAction;
  selectedInstanceId?: string;
  candidateInstanceIds: string[];
  alternatives: string[];
  proposedLaunchTemplate?: LaunchTemplate;
  expected?: LedgerMeasurement<ResourceMetrics>;
  /** Present only when an adapter supplied explicit quota evidence. */
  expectedQuota?: LedgerMeasurement<QuotaValue>;
  factors: StrategyFactor[];
  constraints: StrategyConstraint[];
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  directiveId?: string;
  expiresAt: number;
}

export interface StrategyAdapter {
  readonly strategyVersion: string;
  recommend(input: StrategyInput): StrategyRecommendation;
}

/** Keep recommendation metadata safe for local logs and ledger records. */
export function normalizeStrategyText(value: string, maxLength = 512): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeResourceDirective(
  directive: ResourceDirective | undefined,
): ResourceDirective | undefined {
  if (!directive) return undefined;
  return {
    ...directive,
    reason: normalizeStrategyText(directive.reason),
    requestedBy: normalizeStrategyText(directive.requestedBy, 128),
  };
}

export function isDirectiveActive(directive: ResourceDirective | undefined, now: number): boolean {
  return Boolean(
    directive &&
    directive.createdAt <= now &&
    directive.expiresAt > now &&
    directive.expiresAt > directive.createdAt,
  );
}

export function costValue(cost: CostAmount | undefined): number | undefined {
  return cost && Number.isFinite(cost.amount) ? cost.amount : undefined;
}
