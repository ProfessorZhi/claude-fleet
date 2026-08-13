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

/** How much of the runtime startup interaction Fleet may automate. */
export type RuntimeAutomationMode = 'interactive' | 'unattended';

/** Runtime permission policy; this does not bypass a provider's trust gate. */
export type RuntimePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export type RuntimeBootstrapState =
  'starting' | 'ready' | 'needs_user_interaction' | 'failed' | 'stopped';

export type RuntimeBootstrapReason =
  'startup_interaction' | 'workspace_trust' | 'authentication' | 'unknown';

/** Runtime readiness evidence, separate from the four user-facing state axes. */
export interface RuntimeBootstrapSnapshot {
  state: RuntimeBootstrapState;
  reason?: RuntimeBootstrapReason;
  detail?: string;
  /** Which runtime-owned evidence established readiness, when ready. */
  readinessSource?: 'hook_session_start' | 'native_session' | 'transcript';
  /** Confidence in the readiness evidence; never inferred from process liveness alone. */
  confidence?: 'exact' | 'high' | 'medium' | 'low' | 'unknown';
  observedAt: number;
}

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

export type WorkItemResultOutcome = 'completed' | 'blocked' | 'failed';

/** Bounded, secret-free result metadata returned by a Worker. */
export interface WorkItemResult {
  workItemId: string;
  instanceId: string;
  outcome: WorkItemResultOutcome;
  summary?: string;
  artifactRefs?: string[];
  capturedAt: number;
  source: 'runtime' | 'scm' | 'user' | 'system';
  availability: 'available' | 'partial' | 'unavailable';
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'unknown';
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
  result?: WorkItemResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export type WorktreeStatus = 'reserved' | 'active' | 'released';

/** Safe metadata describing one isolated repository worktree. */
export interface WorktreeRecord {
  worktreeId: string;
  repo: string;
  worktreePath: string;
  branch?: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  status: WorktreeStatus;
  createdAt: number;
  releasedAt?: number;
}

export interface WorktreeCreateRequest {
  worktreeId: string;
  repo: string;
  worktreePath: string;
  branch?: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  createdAt: number;
}

export interface WorktreeConflictCheckRequest {
  repo: string;
  worktreePath: string;
  branch?: string;
  worktreeId?: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
}

export interface WorktreeConflict {
  worktreeId: string;
  reason: 'path' | 'branch';
  worktreePath: string;
  branch?: string;
}

export interface WorktreeConflictCheck {
  conflict: boolean;
  conflicts: WorktreeConflict[];
}

/**
 * Worktree lifecycle boundary. Implementations may provision a real Git
 * worktree, while the management plane only depends on these safe metadata
 * operations.
 */
export interface WorktreeManager {
  create(request: WorktreeCreateRequest): Promise<WorktreeRecord>;
  record(record: WorktreeRecord): Promise<void>;
  checkConflict(request: WorktreeConflictCheckRequest): Promise<WorktreeConflictCheck>;
}

export interface FleetInstance {
  instanceId: string;
  /** User-facing label; separate from Team role metadata. */
  displayName?: string;
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
  requestedProviderProfileId?: string;
  resolvedProviderProfileId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  credential?: 'present' | 'absent';
  refPresent?: boolean;
  refResolution?: 'success' | 'not_required';
  authConfigured?: boolean;
  authInjected?: boolean;
  authVariableNames?: string[];
  baseUrlHost?: string;
  fleet?: FleetIdentity;
  automationMode?: RuntimeAutomationMode;
  permissionMode?: RuntimePermissionMode;
  bootstrap?: RuntimeBootstrapSnapshot;
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
  automationMode?: RuntimeAutomationMode;
  permissionMode?: RuntimePermissionMode;
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
  requestedProviderProfileId?: string;
  resolvedProviderProfileId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  credential?: 'present' | 'absent';
  refPresent?: boolean;
  refResolution?: 'success' | 'not_required';
  authConfigured?: boolean;
  authInjected?: boolean;
  authVariableNames?: string[];
  baseUrlHost?: string;
  startedAt: number;
}

/**
 * Bounded, secret-free work brief accepted by a managed runtime terminal.
 *
 * This is deliberately not a prompt/transcript transport contract. Runtime
 * adapters may add their own native delivery implementation, but the Fleet
 * control plane only sends these four fields.
 */
export interface RuntimeTaskBrief {
  workItemId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
}

export interface RuntimeTaskDeliveryRequest {
  instanceId: string;
  task: RuntimeTaskBrief;
}

/** Transport result retained for API compatibility with the Alpha contract. */
export type RuntimeTaskDeliveryStatus =
  'queued' | 'delivered' | 'unavailable' | 'rejected' | 'cancelled';

/** Authoritative lifecycle for a WorkItem's runtime delivery. */
export type RuntimeTaskDeliveryLifecycle =
  | 'assigned'
  | 'queued_for_runtime'
  | 'delivering'
  | 'delivered_to_runtime'
  | 'failed'
  | 'cancelled';

export type RuntimeTaskDeliveryReason = 'boundary_unavailable' | 'host_failed' | 'invalid_brief';

export interface RuntimeTaskDeliveryResult {
  instanceId: string;
  workItemId: string;
  status: RuntimeTaskDeliveryStatus;
  lifecycle: RuntimeTaskDeliveryLifecycle;
  deliveredAt?: number;
  reason?: RuntimeTaskDeliveryReason;
}

export type RuntimeBootstrapListener = (
  instanceId: string,
  snapshot: RuntimeBootstrapSnapshot,
) => void;

export interface FleetRuntimeHost<Request extends RuntimeLaunchRequest = RuntimeLaunchRequest> {
  readonly hostId: string;
  readonly hostType: string;

  launch(request: Request): Promise<RuntimeLaunchResult>;
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
  /** Optional bounded task-delivery boundary; hosts without it fail closed. */
  sendTask?(instanceId: string, task: RuntimeTaskBrief): Promise<void>;
  /** Secret-free evidence for diagnosing the host transport boundary. */
  getDeliveryDiagnostics?(instanceId: string, workItemId?: string): RuntimeTaskDeliveryDiagnostics;
  /** Optional runtime-ready gate. Hosts without it retain the legacy direct-send path. */
  getBootstrapStatus?(instanceId: string): RuntimeBootstrapSnapshot | undefined;
  /** Emits readiness transitions so queued WorkItems can be flushed exactly once. */
  subscribeBootstrap?(listener: RuntimeBootstrapListener): () => void;
}

export interface RuntimeTaskDeliveryDiagnostics {
  instanceId: string;
  workItemId?: string;
  sendTaskCallCount: number;
  generationAtScheduling?: number;
  generationAfterStartupGrace?: number;
  renderedBriefByteLength?: number;
  resolvedLocalAgentId?: string;
  terminalRef: 'present' | 'absent' | 'unknown';
  terminalExitStatus: 'running' | 'exited' | 'unknown';
  addNewLine: 'yes' | 'no' | 'unknown';
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
