/**
 * Runtime-neutral domain contracts.
 *
 * These are type boundaries only. Native runtime behavior remains in a
 * RuntimeAdapter implementation and is not reimplemented in core.
 */

import type { FleetIdentity } from './fleetContracts.js';
import type { FleetEvent } from './fleetTelemetry.js';

export type FleetRuntime = 'claude-code' | 'codex-cli' | 'other';

export type AgentRole =
  | 'coordinator'
  | 'worker'
  | 'reviewer'
  | 'debugger'
  | 'researcher'
  | 'planner'
  | 'tester'
  | 'subagent'
  | 'external';

export type FleetManagement = 'fleet' | 'external';

export type FleetStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'stopped' | 'error';

export type FleetControlMode = 'observe' | 'suggest' | 'approve' | 'autonomous';

export interface RuntimeCapabilities {
  launch: boolean;
  stop: boolean;
  focus: boolean;
  restart: boolean;
  resume: boolean;
  discover: boolean;
  structuredEvents: boolean;
  nativeSessionContinuity: boolean;
  subagents?: boolean;
  teams?: boolean;
}

export interface CoordinatorRef {
  coordinatorId: string;
  kind: 'external' | 'managed';
  runtime?: FleetRuntime;
  instanceId?: string;
  requestedBy?: string;
}

export interface Mission {
  missionId: string;
  title: string;
  objective: string;
  coordinator?: CoordinatorRef;
  policyMode: FleetControlMode;
  status: 'planned' | 'active' | 'blocked' | 'completed' | 'cancelled';
  repoScope?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkItem {
  workItemId: string;
  missionId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  status: 'queued' | 'assigned' | 'active' | 'blocked' | 'review' | 'completed' | 'cancelled';
  dependencies?: string[];
  repo?: string;
  worktree?: string;
  allowedRuntimeTypes?: FleetRuntime[];
  allowedRoles?: AgentRole[];
  assignedInstanceId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface FleetInstance {
  instanceId: string;
  runtime: FleetRuntime;
  role: AgentRole;
  managedByFleet: boolean;
  missionId?: string;
  workItemId?: string;
  sessionId?: string;
  hostId?: string;
  workspaceId?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  terminalId?: string;
  terminalName?: string;
  launchSource?: string;
  requestedBy?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  fleet?: FleetIdentity;
  status: FleetStatus;
  parentAgentId?: string;
  leadAgentId?: string;
  createdAt: number;
  lastActivityAt?: number;
}

export interface RuntimeLaunchRequest {
  instance: FleetInstance;
  cwd: string;
  sessionMode: 'new' | 'resume';
  sessionId?: string;
  providerProfileId?: string;
  modelId?: string;
  terminalName?: string;
  launchSource?: string;
  requestedBy?: string;
  signal?: AbortSignal;
}

export interface RuntimeLaunchResult {
  instanceId: string;
  sessionId?: string;
  terminalId?: string;
  terminalName?: string;
  hostId?: string;
  workspaceId?: string;
  launchSource?: string;
  requestedBy?: string;
  startedAt: number;
}

export interface FleetRuntimeHost<Request extends RuntimeLaunchRequest = RuntimeLaunchRequest> {
  readonly hostId: string;
  readonly hostType: string;

  launch(request: Request): Promise<RuntimeLaunchResult>;
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
}

export interface RuntimeAdapter {
  readonly runtime: FleetRuntime;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;

  detect(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
  buildLaunchSpec(request: RuntimeLaunchRequest): Promise<unknown>;
  launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
  restart(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  resume(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  discover(): Promise<ReadonlyArray<Partial<FleetInstance>>>;
  normalizeEvent(input: unknown): FleetEvent | undefined;
}
