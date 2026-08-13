/**
 * Fleet Control API contracts.
 *
 * This file defines the management-plane request/response boundary only. It
 * does not open sockets, spawn runtimes, or implement MCP.
 */

import type {
  CostAmount,
  QualitySignal,
  QuotaSnapshot,
  SessionRecord,
  TokenUsage,
  UsageRecord,
} from './ledgerContracts.js';
import { validateLedgerPayload } from './ledgerContracts.js';
import type {
  AgentRole,
  FleetControlMode,
  FleetInstance,
  FleetRuntime,
  Mission,
  RuntimeAutomationMode,
  RuntimeLaunchResult,
  RuntimePermissionMode,
  RuntimeTaskDeliveryResult,
  RuntimeTransport,
  WorkItem,
  WorkItemResult,
} from './runtimeContracts.js';
import type { StrategyInput, StrategyPolicy, StrategyRecommendation } from './strategyContracts.js';

export type FleetControlAction =
  | 'create_mission'
  | 'create_work_item'
  | 'assign_work_item'
  | 'deliver_work_item'
  | 'coordinator_plan'
  | 'coordinator_tick'
  | 'record_telemetry'
  | 'record_quality'
  | 'launch_instance'
  | 'get_status'
  | 'focus_instance'
  | 'stop_instance'
  | 'restart_instance'
  | 'resume_instance'
  | 'collect_result'
  | 'recommend_assignment';

export type FleetControlDecision = 'accepted' | 'approval_required' | 'rejected' | 'unavailable';

export interface FleetControlPolicy extends StrategyPolicy {}

export interface FleetLaunchTemplate {
  runtime: FleetRuntime;
  /** Defaults to the existing terminal transport. */
  transport?: RuntimeTransport;
  role: AgentRole;
  displayName?: string;
  repo: string;
  worktree?: string;
  branch?: string;
  cwd: string;
  providerProfileId?: string;
  modelId?: string;
  resourceAccountId?: string;
  hostId?: string;
  workspaceId?: string;
  terminalPolicy?: 'reuse' | 'new';
  sessionMode?: 'new' | 'resume';
  sessionId?: string;
  automationMode?: RuntimeAutomationMode;
  permissionMode?: RuntimePermissionMode;
  launchSource?: string;
  requestedBy: string;
  policy: FleetControlPolicy;
}

export interface FleetMissionInput {
  missionId: string;
  title: string;
  objective: string;
  policyMode: FleetControlMode;
  repoScope?: string[];
}

export interface FleetWorkItemInput {
  workItemId: string;
  missionId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  repo?: string;
  worktree?: string;
  allowedRuntimeTypes?: FleetRuntime[];
  allowedRoles?: AgentRole[];
}

export interface FleetWorkItemResultInput {
  /** Optional when the control plane can correlate from instanceId. */
  workItemId?: string;
  instanceId?: string;
  outcome: 'completed' | 'blocked' | 'failed';
  summary?: string;
  artifactRefs?: string[];
  capturedAt?: number;
  source?: 'runtime' | 'scm' | 'user' | 'system';
  availability?: 'available' | 'partial' | 'unavailable';
  confidence?: 'exact' | 'high' | 'medium' | 'low' | 'unknown';
}

export type FleetCoordinatorSessionOperation = 'plan' | 'tick';

/**
 * Reference to a registered, explicit Coordinator session.
 *
 * Authentication of the HTTP boundary remains Bearer-token based. The
 * sessionId/requestedBy pair is the management-plane authorization binding;
 * it is never a secret and is not persisted as credential material.
 */
export interface FleetCoordinatorSessionInput {
  sessionId: string;
  operation: FleetCoordinatorSessionOperation;
}

/**
 * Result envelope for one explicit Coordinator plan/tick invocation.
 * `plan` and `tick` contain the scheduler's bounded JSON projection. They are
 * intentionally not Runtime prompt/transcript payloads.
 */
export interface FleetCoordinatorSessionResult {
  sessionId: string;
  operation: FleetCoordinatorSessionOperation;
  capturedAt: number;
  plan?: unknown;
  tick?: unknown;
}

export interface FleetTelemetryInput {
  usage?: UsageRecord;
  quota?: QuotaSnapshot;
}

export interface FleetControlRequest {
  requestId: string;
  action: FleetControlAction;
  mode: FleetControlMode;
  requestedBy: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  mission?: FleetMissionInput;
  workItem?: FleetWorkItemInput;
  result?: FleetWorkItemResultInput;
  telemetry?: FleetTelemetryInput;
  quality?: QualitySignal;
  coordinatorSession?: FleetCoordinatorSessionInput;
  launch?: FleetLaunchTemplate;
  strategy?: StrategyInput;
  createdAt: number;
}

export interface FleetControlResponse {
  requestId: string;
  decision: FleetControlDecision;
  reason?: string;
  mission?: Mission;
  workItem?: WorkItem;
  result?: WorkItemResult;
  delivery?: RuntimeTaskDeliveryResult;
  coordinator?: FleetCoordinatorSessionResult;
  telemetry?: { usageId?: string; snapshotId?: string };
  quality?: QualitySignal;
  instance?: FleetInstance;
  launchResult?: RuntimeLaunchResult;
  recommendation?: StrategyRecommendation;
  acceptedAt?: number;
}

export interface FleetMetricsSession extends SessionRecord {
  /** Wall-clock elapsed time at the moment this snapshot was captured. */
  elapsedMs: number;
}

export interface FleetMetricsSnapshot {
  capturedAt: number;
  instanceId?: string;
  usage: UsageRecord[];
  sessions: FleetMetricsSession[];
  quotas: QuotaSnapshot[];
  totals: {
    durationMs: number;
    tokens: TokenUsage;
    /** Aggregated only when all observed costs share currency and basis. */
    cost?: CostAmount;
    costs?: {
      apiEquivalent?: CostAmount;
      metered?: CostAmount;
      subscription?: SubscriptionCostAggregate;
    };
    quotaUsage?: QuotaUsageAggregate[];
  };
}

export interface SubscriptionCostAggregate {
  amount: number;
  currency: string;
  basis: 'subscription-amortized';
  fractionOfPeriod: number;
  consumedPercentage: number;
  records: number;
  planTypes: string[];
}

export interface QuotaUsageAggregate {
  resourceAccountId?: string;
  planType?: string;
  billingMode?: 'metered' | 'subscription' | 'credits' | 'unknown';
  window: 'session' | 'five-hour' | 'daily' | 'weekly' | 'monthly' | 'custom';
  consumedPercentage: number;
  fractionOfWindow: number;
  records: number;
}

export interface FleetControlApi {
  submit(request: FleetControlRequest): Promise<FleetControlResponse>;
  getInstance(instanceId: string): Promise<FleetInstance | undefined>;
  listInstances(): FleetInstance[] | Promise<FleetInstance[]>;
  getMetrics(
    instanceId?: string,
    workItemId?: string,
  ): FleetMetricsSnapshot | Promise<FleetMetricsSnapshot>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getWorkItem(workItemId: string): Promise<WorkItem | undefined>;
  /** Read-only delivery lifecycle used to distinguish host-send from runtime ACK. */
  getDeliveryStatus?(
    workItemId: string,
    instanceId?: string,
  ): RuntimeTaskDeliveryResult | undefined;
  /** Secret-free delivery/transport evidence for an individual WorkItem. */
  getDeliveryDiagnostics?(
    workItemId: string,
    instanceId?: string,
  ): Record<string, unknown> | undefined;
  /** Read-only quality evidence projection, optionally scoped to a WorkItem. */
  getQuality?(workItemId?: string): QualitySignal[] | Promise<QualitySignal[]>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

function validateRequiredId(value: string | undefined, field: string): string | null {
  if (!value || !isSafeId(value)) return field + ' must be a safe non-empty identifier.';
  return null;
}

/**
 * Validate a control request before it reaches a host or RuntimeAdapter.
 *
 * This is deliberately conservative. It validates the management metadata
 * available at the boundary and never attempts to inspect or forward secrets.
 */
export function validateFleetControlRequest(request: FleetControlRequest): string | null {
  const requestError = validateRequiredId(request.requestId, 'requestId');
  if (requestError) return requestError;

  const requesterError = validateRequiredId(request.requestedBy, 'requestedBy');
  if (requesterError) return requesterError;

  if (!Number.isFinite(request.createdAt) || request.createdAt <= 0) {
    return 'createdAt must be a positive timestamp.';
  }

  for (const [value, field] of [
    [request.missionId, 'missionId'],
    [request.workItemId, 'workItemId'],
    [request.instanceId, 'instanceId'],
  ] as const) {
    if (value !== undefined) {
      const error = validateRequiredId(value, field);
      if (error) return error;
    }
  }

  if (request.action === 'launch_instance') {
    if (!request.launch) return 'launch is required for launch_instance.';
    const launchError = validateLaunchTemplate(request.launch);
    if (launchError) return launchError;
  }

  if (request.action === 'recommend_assignment') {
    if (!request.workItemId) return 'workItemId is required for recommend_assignment.';
    if (!request.strategy) return 'strategy is required for recommend_assignment.';
    if (request.strategy.workItem.workItemId !== request.workItemId) {
      return 'strategy.workItem.workItemId must match workItemId.';
    }
    if (request.strategy.policy.mode !== request.mode) {
      return 'strategy.policy.mode must match request mode.';
    }
    if (!Number.isFinite(request.strategy.now) || request.strategy.now <= 0) {
      return 'strategy.now must be a positive timestamp.';
    }
  }

  if (request.action === 'assign_work_item') {
    if (!request.missionId) return 'missionId is required for assign_work_item.';
    if (!request.workItemId) return 'workItemId is required for assign_work_item.';
    if (!request.instanceId) return 'instanceId is required for assign_work_item.';
  }

  if (request.action === 'coordinator_plan' || request.action === 'coordinator_tick') {
    if (!request.coordinatorSession) {
      return 'coordinatorSession is required for Coordinator session actions.';
    }
    const sessionError = validateRequiredId(
      request.coordinatorSession.sessionId,
      'coordinatorSession.sessionId',
    );
    if (sessionError) return sessionError;
    const expectedOperation = request.action === 'coordinator_plan' ? 'plan' : 'tick';
    if (request.coordinatorSession.operation !== expectedOperation) {
      return `coordinatorSession.operation must be ${expectedOperation}.`;
    }
  }

  if (request.action === 'deliver_work_item') {
    if (!request.missionId) return 'missionId is required for deliver_work_item.';
    if (!request.workItemId) return 'workItemId is required for deliver_work_item.';
    if (!request.instanceId) return 'instanceId is required for deliver_work_item.';
  }

  if (request.action === 'collect_result') {
    if (!request.result) return 'result is required for collect_result.';
    if (typeof request.result !== 'object' || Array.isArray(request.result)) {
      return 'result must be a bounded object.';
    }
    if (!request.workItemId && !request.result.workItemId && !request.result.instanceId) {
      return 'collect_result requires workItemId or result.instanceId for correlation.';
    }
    if (
      request.workItemId &&
      request.result.workItemId &&
      request.result.workItemId !== request.workItemId
    ) {
      return 'result.workItemId must match workItemId.';
    }
    if (request.result.workItemId !== undefined) {
      const resultWorkItemError = validateRequiredId(
        request.result.workItemId,
        'result.workItemId',
      );
      if (resultWorkItemError) return resultWorkItemError;
    }
    const allowedResultFields = new Set([
      'workItemId',
      'instanceId',
      'outcome',
      'summary',
      'artifactRefs',
      'capturedAt',
      'source',
      'availability',
      'confidence',
    ]);
    const unknownResultField = Object.keys(request.result).find(
      (field) => !allowedResultFields.has(field),
    );
    if (unknownResultField) {
      return `result.${unknownResultField} is not allowed in the bounded result envelope.`;
    }
    if (request.result.summary !== undefined && typeof request.result.summary !== 'string') {
      return 'result.summary must be a string.';
    }
    if (request.result.summary !== undefined && request.result.summary.length > 2000) {
      return 'result.summary must be at most 2000 characters.';
    }
    if (request.result.artifactRefs && request.result.artifactRefs.length > 32) {
      return 'result.artifactRefs must contain at most 32 entries.';
    }
    if (
      request.result.artifactRefs !== undefined &&
      (!Array.isArray(request.result.artifactRefs) ||
        request.result.artifactRefs.some((ref) => typeof ref !== 'string'))
    ) {
      return 'result.artifactRefs must be an array of strings.';
    }
    if (request.result.artifactRefs?.some((ref) => ref.length > 500)) {
      return 'result.artifactRefs entries must be at most 500 characters.';
    }
    if (request.result.instanceId !== undefined) {
      const instanceError = validateRequiredId(request.result.instanceId, 'result.instanceId');
      if (instanceError) return instanceError;
    }
    if (
      request.result.outcome !== 'completed' &&
      request.result.outcome !== 'blocked' &&
      request.result.outcome !== 'failed'
    ) {
      return 'result.outcome is invalid.';
    }
    if (
      request.result.capturedAt !== undefined &&
      (!Number.isFinite(request.result.capturedAt) || request.result.capturedAt <= 0)
    ) {
      return 'result.capturedAt must be a positive timestamp.';
    }
  }

  if (request.action === 'record_telemetry') {
    if (!request.telemetry?.usage && !request.telemetry?.quota) {
      return 'telemetry requires usage or quota.';
    }
  }

  if (request.action === 'record_quality') {
    const qualityError = validateQualitySignal(request.quality);
    if (qualityError) return qualityError;
  }

  if (request.action === 'create_mission') {
    if (!request.mission) return 'mission is required for create_mission.';
    const missionError = validateRequiredId(request.mission.missionId, 'mission.missionId');
    if (missionError) return missionError;
    if (!request.mission.title.trim() || !request.mission.objective.trim()) {
      return 'mission title and objective are required.';
    }
  }

  if (request.action === 'create_work_item') {
    if (!request.workItem) return 'workItem is required for create_work_item.';
    const workItemError = validateRequiredId(request.workItem.workItemId, 'workItem.workItemId');
    if (workItemError) return workItemError;
    const missionError = validateRequiredId(request.workItem.missionId, 'workItem.missionId');
    if (missionError) return missionError;
    if (!request.workItem.title.trim() || !request.workItem.objective.trim()) {
      return 'workItem title and objective are required.';
    }
    if (request.workItem.acceptanceCriteria.length === 0) {
      return 'workItem acceptanceCriteria must not be empty.';
    }
  }

  // Launch policy budgets authorize creating a new runtime instance. Existing
  // instance operations (for example deliver_work_item) must not require a
  // redundant launch template; their own side-effect policy checks apply in
  // FleetControlService.
  if (
    request.action === 'launch_instance' &&
    request.mode === 'autonomous' &&
    request.launch?.policy.mode !== 'autonomous'
  ) {
    return 'autonomous requests require an autonomous launch policy.';
  }

  return null;
}

export function validateLaunchTemplate(template: FleetLaunchTemplate): string | null {
  if (!template.repo || !template.cwd) return 'launch repo and cwd are required.';
  const requesterError = validateRequiredId(template.requestedBy, 'launch.requestedBy');
  if (requesterError) return requesterError;

  // A Coordinator/API Claude launch must state its provider identity. The
  // Extension Host may resolve the profile's SecretRef, but it must never
  // guess Anthropic/Inherit when the caller forgot the provider field.
  const isApiControlledLaunch =
    template.launchSource === 'coordinator' || template.launchSource === 'fleet-control-api';
  if (template.runtime === 'claude-code' && isApiControlledLaunch && !template.providerProfileId) {
    return 'PROVIDER_PROFILE_REQUIRED';
  }

  if (template.sessionMode === 'resume' && !template.sessionId) {
    return 'resume launch requires sessionId.';
  }

  if (template.policy.mode === 'autonomous') {
    if (
      template.policy.maxConcurrentInstances === undefined ||
      template.policy.maxConcurrentInstances < 1
    ) {
      return 'autonomous policy requires maxConcurrentInstances.';
    }
    if (
      template.policy.maxTokenBudget === undefined &&
      template.policy.maxCostBudget === undefined
    ) {
      return 'autonomous policy requires a token or cost budget.';
    }
  }

  return null;
}

function validateQualitySignal(value: QualitySignal | undefined): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'quality is required and must be a bounded object.';
  }
  const payloadErrors = validateLedgerPayload(value);
  if (payloadErrors.length > 0) {
    return 'quality contains forbidden secret, transcript, environment, or raw payload fields.';
  }
  const signalIdError = validateRequiredId(value.signalId, 'quality.signalId');
  if (signalIdError) return signalIdError;
  for (const [candidate, field] of [
    [value.missionId, 'quality.missionId'],
    [value.workItemId, 'quality.workItemId'],
    [value.instanceId, 'quality.instanceId'],
    [value.pullRequestId, 'quality.pullRequestId'],
  ] as const) {
    if (candidate !== undefined) {
      const error = validateRequiredId(candidate, field);
      if (error) return error;
    }
  }
  if (
    !['test', 'review', 'build', 'lint', 'merge', 'pull-request', 'ci', 'user', 'runtime'].includes(
      value.kind,
    )
  ) {
    return 'quality.kind is invalid.';
  }
  if (!['passed', 'failed', 'warning', 'neutral'].includes(value.outcome)) {
    return 'quality.outcome is invalid.';
  }
  if (!Number.isFinite(value.capturedAt) || value.capturedAt <= 0) {
    return 'quality.capturedAt must be a positive timestamp.';
  }
  if (
    value.summary !== undefined &&
    (typeof value.summary !== 'string' || value.summary.length > 2000)
  ) {
    return 'quality.summary must be a string of at most 2000 characters.';
  }
  if (
    value.score !== undefined &&
    (!Number.isFinite(value.score) || value.score < 0 || value.score > 100)
  ) {
    return 'quality.score must be between 0 and 100.';
  }
  if (
    !['runtime', 'scm', 'user', 'system', 'external', 'ledger', 'agentmetrics'].includes(
      value.source,
    )
  ) {
    return 'quality.source is invalid.';
  }
  if (!['available', 'partial', 'unavailable'].includes(value.availability)) {
    return 'quality.availability is invalid.';
  }
  if (!['exact', 'high', 'medium', 'low', 'unknown'].includes(value.confidence)) {
    return 'quality.confidence is invalid.';
  }
  if (!['estimate', 'actual'].includes(value.estimateOrActual)) {
    return 'quality.estimateOrActual is invalid.';
  }
  return null;
}
