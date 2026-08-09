/**
 * Fleet Control API contracts.
 *
 * This file defines the management-plane request/response boundary only. It
 * does not open sockets, spawn runtimes, or implement MCP.
 */

import type {
  AgentRole,
  FleetControlMode,
  FleetInstance,
  FleetRuntime,
  Mission,
  RuntimeLaunchResult,
  WorkItem,
} from './runtimeContracts.js';
import type { StrategyInput, StrategyPolicy, StrategyRecommendation } from './strategyContracts.js';

export type FleetControlAction =
  | 'create_mission'
  | 'create_work_item'
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
  role: AgentRole;
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
  instance?: FleetInstance;
  launchResult?: RuntimeLaunchResult;
  recommendation?: StrategyRecommendation;
  acceptedAt?: number;
}

export interface FleetControlApi {
  submit(request: FleetControlRequest): Promise<FleetControlResponse>;
  getInstance(instanceId: string): Promise<FleetInstance | undefined>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getWorkItem(workItemId: string): Promise<WorkItem | undefined>;
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

  if (request.mode === 'autonomous' && request.launch?.policy.mode !== 'autonomous') {
    return 'autonomous requests require an autonomous launch policy.';
  }

  return null;
}

export function validateLaunchTemplate(template: FleetLaunchTemplate): string | null {
  if (!template.repo || !template.cwd) return 'launch repo and cwd are required.';
  const requesterError = validateRequiredId(template.requestedBy, 'launch.requestedBy');
  if (requesterError) return requesterError;

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
