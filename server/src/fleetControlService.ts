import type {
  FleetMetricsSession,
  FleetMetricsSnapshot,
  QuotaUsageAggregate,
  SubscriptionCostAggregate,
} from '../../core/src/controlContracts.js';
import {
  type FleetControlApi,
  type FleetControlRequest,
  type FleetControlResponse,
  type FleetLaunchTemplate,
  validateFleetControlRequest,
} from '../../core/src/controlContracts.js';
import type {
  CostAmount,
  QualitySignal,
  SessionStatus,
  SubscriptionCostAllocation,
  TokenUsage,
  UsageCostBreakdown,
  UsageRecord,
} from '../../core/src/ledgerContracts.js';
import type {
  FleetInstance,
  FleetRuntime,
  FleetRuntimeHost,
  Mission,
  RuntimeAdapter,
  RuntimeLaunchRequest,
  WorkItem,
  WorkItemResult,
  WorktreeConflictCheck,
  WorktreeConflictCheckRequest,
  WorktreeCreateRequest,
  WorktreeManager,
  WorktreeRecord,
} from '../../core/src/runtimeContracts.js';
import type { StrategyAdapter } from '../../core/src/strategyContracts.js';
import { CoordinatorSession, coordinatorSessionRequestFromControl } from './coordinatorSession.js';
import { FleetLedgerStore } from './fleetLedgerStore.js';
import { FleetStrategyAdapter } from './fleetStrategy.js';
import { LedgerWorktreeManager } from './persistence/worktreeManager.js';
import { deliverRuntimeTask } from './runtimeTaskDelivery.js';

export interface FleetRuntimeRegistration {
  adapter: RuntimeAdapter;
  host: FleetRuntimeHost;
}

export interface FleetControlServiceOptions {
  ledger?: FleetLedgerStore;
  now?: () => number;
  registrations?: FleetRuntimeRegistration[];
  instances?: FleetInstance[];
  missions?: Mission[];
  workItems?: WorkItem[];
  strategy?: StrategyAdapter;
  worktrees?: WorktreeManager;
  coordinatorSessions?: CoordinatorSession[];
}

/**
 * In-memory management-plane implementation.
 *
 * This is deliberately a narrow execution boundary: suggest/observe requests
 * only produce an approval decision, while approve/autonomous requests must
 * pass policy checks and then go through a registered RuntimeAdapter and
 * FleetRuntimeHost. It has no scheduler, transport, MCP server, or process
 * spawning of its own.
 */
export class FleetControlService implements FleetControlApi {
  readonly ledger: FleetLedgerStore;
  readonly worktrees: WorktreeManager;

  private readonly now: () => number;
  private readonly registrations = new Map<FleetRuntime, FleetRuntimeRegistration>();
  private readonly instances = new Map<string, FleetInstance>();
  private readonly missions = new Map<string, Mission>();
  private readonly workItems = new Map<string, WorkItem>();
  private readonly responses = new Map<string, FleetControlResponse>();
  private readonly strategy: StrategyAdapter;
  private readonly coordinatorSessions = new Map<string, CoordinatorSession>();

  constructor(options: FleetControlServiceOptions = {}) {
    this.ledger = options.ledger ?? new FleetLedgerStore();
    this.worktrees = options.worktrees ?? new LedgerWorktreeManager(this.ledger);
    this.now = options.now ?? (() => Date.now());
    this.strategy = options.strategy ?? new FleetStrategyAdapter();
    for (const session of options.coordinatorSessions ?? [])
      this.registerCoordinatorSession(session);
    for (const registration of options.registrations ?? []) this.registerRuntime(registration);
    for (const instance of options.instances ?? [])
      this.instances.set(instance.instanceId, clone(instance));
    for (const mission of this.ledger.listMissions()) {
      this.missions.set(mission.missionId, missionFromRecord(mission));
    }
    for (const workItem of this.ledger.listWorkItems()) {
      this.workItems.set(workItem.workItemId, workItemFromRecord(workItem));
    }
    for (const mission of options.missions ?? [])
      this.missions.set(mission.missionId, clone(mission));
    for (const workItem of options.workItems ?? [])
      this.workItems.set(workItem.workItemId, clone(workItem));
  }

  registerRuntime(registration: FleetRuntimeRegistration): void {
    this.registrations.set(registration.adapter.runtime, registration);
  }

  registerCoordinatorSession(session: CoordinatorSession): void {
    this.coordinatorSessions.set(session.sessionId, session);
  }

  async submit(request: FleetControlRequest): Promise<FleetControlResponse> {
    const previous = this.responses.get(request.requestId);
    if (previous) return clone(previous);

    const validationError = validateFleetControlRequest(request);
    if (validationError) {
      return this.finish(request, {
        requestId: request.requestId,
        decision: 'rejected',
        reason: validationError,
      });
    }

    let response: FleetControlResponse;
    switch (request.action) {
      case 'create_mission':
        response = this.createMission(request);
        break;
      case 'create_work_item':
        response = await this.createWorkItem(request);
        break;
      case 'assign_work_item':
        response = this.assignWorkItem(request);
        break;
      case 'deliver_work_item':
        response = await this.deliverWorkItem(request);
        break;
      case 'coordinator_plan':
      case 'coordinator_tick':
        response = await this.invokeCoordinatorSession(request);
        break;
      case 'record_telemetry':
        response = this.recordTelemetry(request);
        break;
      case 'record_quality':
        response = this.recordQuality(request);
        break;
      case 'launch_instance':
        response = await this.launch(request);
        break;
      case 'get_status':
        response = this.getStatus(request);
        break;
      case 'focus_instance':
        response = await this.focus(request);
        break;
      case 'stop_instance':
        response = await this.stop(request);
        break;
      case 'restart_instance':
        response = await this.restart(request);
        break;
      case 'resume_instance':
        response = await this.resume(request);
        break;
      case 'collect_result':
        response = this.collectResult(request);
        break;
      case 'recommend_assignment':
        response = this.recommendAssignment(request);
        break;
      default:
        response = {
          requestId: request.requestId,
          decision: 'rejected',
          reason: 'Unsupported control action.',
        };
        break;
    }

    return this.finish(request, response);
  }

  async getInstance(instanceId: string): Promise<FleetInstance | undefined> {
    return clone(this.instances.get(instanceId));
  }

  /** Register or refresh a runtime snapshot supplied by the host/discovery layer. */
  upsertInstance(instance: FleetInstance): void {
    const previous = this.instances.get(instance.instanceId);
    this.instances.set(
      instance.instanceId,
      clone({
        ...previous,
        ...instance,
        ...(instance.missionId === undefined && previous?.missionId
          ? { missionId: previous.missionId }
          : {}),
        ...(instance.workItemId === undefined && previous?.workItemId
          ? { workItemId: previous.workItemId }
          : {}),
      }),
    );
  }

  /**
   * Observe a real runtime owned by a host (including one launched from the
   * VS Code UI). Control API launches already create ledger records in
   * `launch`; host-discovered agents need this bridge so metrics do not depend
   * on which surface started the terminal.
   */
  observeRuntimeInstance(instance: FleetInstance): void {
    const observedAt = this.now();
    const previousInstance = this.instances.get(instance.instanceId);
    // Host projections are intentionally partial: AgentState does not own
    // Coordinator metadata such as mission/workItem assignment. Preserve the
    // management-plane correlation when a lifecycle/status broadcast omits it.
    const observed = {
      ...previousInstance,
      ...instance,
      ...(instance.missionId === undefined && previousInstance?.missionId
        ? { missionId: previousInstance.missionId }
        : {}),
      ...(instance.workItemId === undefined && previousInstance?.workItemId
        ? { workItemId: previousInstance.workItemId }
        : {}),
    } satisfies FleetInstance;
    this.instances.set(instance.instanceId, clone(observed));
    if (!observed.sessionId) return;

    // Codex may replace the launch placeholder with the native JSONL session
    // id after the terminal starts. Close the placeholder session immediately
    // so elapsed time is not counted twice while keeping its launch evidence.
    if (previousInstance?.sessionId && previousInstance.sessionId !== observed.sessionId) {
      const placeholder = this.ledger.getSession(previousInstance.sessionId);
      if (placeholder && !['stopped', 'error'].includes(placeholder.status)) {
        this.ledger.upsertSession({
          ...placeholder,
          status: 'stopped',
          endedAt: placeholder.startedAt,
        });
      }
    }

    const previous = this.ledger.getSession(observed.sessionId);
    const status = sessionStatusForFleetStatus(observed.status);
    this.ledger.upsertSession({
      sessionId: observed.sessionId,
      instanceId: observed.instanceId,
      runtime: observed.runtime,
      managedByFleet: observed.managedByFleet,
      missionId: observed.missionId,
      workItemId: observed.workItemId,
      hostId: observed.hostId,
      workspaceId: observed.workspaceId,
      workspacePath: observed.repo,
      repo: observed.repo,
      worktree: observed.worktree,
      terminalId: observed.terminalId,
      terminalName: observed.terminalName,
      providerProfileId: observed.providerProfileId,
      providerDisplayName: observed.providerDisplayName,
      modelId: observed.modelId,
      status,
      launchSource: observed.launchSource,
      requestedBy: observed.requestedBy,
      startedAt: previous?.startedAt ?? observed.createdAt,
      ...(status === 'stopped' || status === 'error'
        ? { endedAt: previous?.endedAt ?? observedAt }
        : {}),
    });
    this.ledger.recordQuota({
      snapshotId: `live-quota-${observed.instanceId}`,
      resourceAccountId: observed.instanceId,
      runtime: observed.runtime,
      providerDisplayName: observed.providerDisplayName,
      window: 'session',
      capturedAt: observedAt,
      source: 'system',
      availability: 'unavailable',
      confidence: 'unknown',
      estimateOrActual: 'actual',
    });
  }

  /** Record cumulative transcript usage for a live host instance. */
  recordLiveUsage(
    instanceId: string,
    runtime: FleetRuntime | undefined,
    providerDisplayName: string | undefined,
    modelId: string | undefined,
    input: unknown,
    capturedAt = this.now(),
    durationMs?: number,
  ): void {
    const tokens = normalizeLiveTokenUsage(input);
    if (!tokens) return;
    const instance = this.instances.get(instanceId);
    const sessionId = instance?.sessionId;
    this.ledger.recordUsage({
      usageId: `live-${instanceId}`,
      instanceId,
      sessionId,
      runtime: runtime ?? instance?.runtime,
      missionId: instance?.missionId,
      workItemId: instance?.workItemId,
      providerDisplayName: providerDisplayName ?? instance?.providerDisplayName,
      modelId: modelId ?? instance?.modelId,
      capturedAt,
      aggregation: 'session-cumulative',
      ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
        ? { durationMs: Math.round(durationMs) }
        : {}),
      tokens,
      source: 'system',
      availability: 'partial',
      confidence: 'high',
      estimateOrActual: 'actual',
    });
  }

  /** Preserve a stopped instance in management history without deleting it. */
  markInstanceStopped(instanceId: string, observedAt = this.now()): void {
    const previous = this.instances.get(instanceId);
    if (!previous) return;
    this.instances.set(
      instanceId,
      clone({ ...previous, status: 'stopped', lastActivityAt: observedAt }),
    );
    for (const session of this.ledger.listSessions(instanceId)) {
      this.ledger.upsertSession({ ...session, status: 'stopped', endedAt: observedAt });
    }
  }

  listInstances(): FleetInstance[] {
    return [...this.instances.values()].map((instance) => clone(instance));
  }

  listWorkItems(missionId?: string): WorkItem[] {
    return [...this.workItems.values()]
      .filter((workItem) => !missionId || workItem.missionId === missionId)
      .map((workItem) => clone(workItem));
  }

  getMetrics(instanceId?: string, workItemId?: string): FleetMetricsSnapshot {
    const capturedAt = this.now();
    const usage = this.ledger.listUsage(instanceId, workItemId);
    const sessions = this.ledger.listSessions(instanceId, workItemId).map((session) => ({
      ...session,
      elapsedMs: Math.max(0, (session.endedAt ?? capturedAt) - session.startedAt),
    }));
    const aggregatedUsage = selectUsageForAggregation(usage);
    const sessionIds = new Set(sessions.map((session) => session.sessionId));
    const durationMs =
      sessions.reduce((total, session) => total + session.elapsedMs, 0) +
      aggregatedUsage.reduce(
        (total, record) =>
          total +
          (!record.sessionId || !sessionIds.has(record.sessionId) ? (record.durationMs ?? 0) : 0),
        0,
      );
    const tokens = aggregatedUsage.reduce(
      (total, record) => addTokenUsage(total, record.tokens),
      {},
    );
    const cost = aggregateCost(aggregatedUsage);
    const costs = aggregateTotalCosts(aggregatedUsage);
    const quotaUsage = aggregateQuotaUsage(aggregatedUsage);
    const sessionMetrics = new Map<string, FleetMetricsSession['metrics']>();
    for (const session of sessions) {
      const records = aggregatedUsage.filter((record) => record.sessionId === session.sessionId);
      if (records.length === 0) continue;
      const sessionTokens = records.reduce(
        (total, record) => addTokenUsage(total, record.tokens),
        {},
      );
      const sessionCost = aggregateCost(records);
      const sessionCosts = aggregateCosts(records);
      const sessionQuota = records.length === 1 ? records[0].quotaImpact : undefined;
      sessionMetrics.set(session.sessionId, {
        actual: {
          value: {
            durationMs: session.elapsedMs,
            ...(Object.keys(sessionTokens).length > 0 ? { tokens: sessionTokens } : {}),
            ...(sessionCost ? { cost: sessionCost } : {}),
            ...(sessionCosts ? { costs: sessionCosts } : {}),
            ...(sessionQuota ? { quotaImpact: sessionQuota } : {}),
          },
          source: 'ledger',
          availability: records.some((record) => record.availability === 'available')
            ? 'available'
            : 'partial',
          confidence: lowestConfidence(records),
          estimateOrActual: records.some((record) => record.estimateOrActual === 'estimate')
            ? 'estimate'
            : 'actual',
          observedAt: Math.max(...records.map((record) => record.capturedAt)),
        },
      });
    }
    const metricsSessions = sessions.map((session) => {
      const metrics = sessionMetrics.get(session.sessionId);
      return metrics ? { ...session, metrics } : session;
    });

    return {
      capturedAt,
      ...(instanceId ? { instanceId } : {}),
      usage,
      sessions: metricsSessions,
      // Quotas are keyed by provider resource account rather than instance;
      // keep the full evidence set for an instance query instead of guessing
      // that an account id equals an agent id.
      quotas: this.ledger.listQuota(),
      totals: {
        durationMs,
        tokens,
        ...(cost ? { cost } : {}),
        ...(costs ? { costs } : {}),
        ...(quotaUsage.length > 0 ? { quotaUsage } : {}),
      },
    };
  }

  getQuality(workItemId?: string): QualitySignal[] {
    return this.ledger.listQuality(workItemId);
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return clone(this.missions.get(missionId));
  }

  async getWorkItem(workItemId: string): Promise<WorkItem | undefined> {
    return clone(this.workItems.get(workItemId));
  }

  async checkWorktreeConflict(
    request: WorktreeConflictCheckRequest,
  ): Promise<WorktreeConflictCheck> {
    return this.worktrees.checkConflict(request);
  }

  async createWorktree(request: WorktreeCreateRequest): Promise<WorktreeRecord> {
    return this.worktrees.create(request);
  }

  async recordWorktree(record: WorktreeRecord): Promise<void> {
    await this.worktrees.record(record);
  }

  private createMission(request: FleetControlRequest): FleetControlResponse {
    const input = request.mission!;
    const existing = this.missions.get(input.missionId);
    if (existing) {
      return sameMission(existing, input)
        ? {
            requestId: request.requestId,
            decision: 'accepted',
            mission: clone(existing),
            acceptedAt: this.now(),
          }
        : {
            requestId: request.requestId,
            decision: 'rejected',
            reason: 'missionId already exists with different content.',
          };
    }
    const createdAt = this.now();
    const mission: Mission = {
      missionId: input.missionId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      policyMode: input.policyMode,
      status: 'planned',
      repoScope: input.repoScope,
      createdAt,
    };
    this.missions.set(mission.missionId, mission);
    this.ledger.upsertMission({
      missionId: mission.missionId,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      coordinatorId: request.requestedBy,
      repoScope: mission.repoScope,
      createdAt,
    });
    return {
      requestId: request.requestId,
      decision: 'accepted',
      mission: clone(mission),
      acceptedAt: createdAt,
    };
  }

  private async createWorkItem(request: FleetControlRequest): Promise<FleetControlResponse> {
    const input = request.workItem!;
    if (!this.missions.has(input.missionId)) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Mission not found.',
      };
    }
    const existing = this.workItems.get(input.workItemId);
    if (existing) {
      return sameWorkItem(existing, input)
        ? {
            requestId: request.requestId,
            decision: 'accepted',
            workItem: clone(existing),
            acceptedAt: this.now(),
          }
        : {
            requestId: request.requestId,
            decision: 'rejected',
            reason: 'workItemId already exists with different content.',
          };
    }
    if (input.repo && input.worktree) {
      const conflict = await this.worktrees.checkConflict({
        repo: input.repo,
        worktreePath: input.worktree,
        workItemId: input.workItemId,
      });
      if (conflict.conflict) {
        return {
          requestId: request.requestId,
          decision: 'rejected',
          reason: 'WorkItem worktree conflicts with an active worktree.',
        };
      }
    }
    const createdAt = this.now();
    const workItem: WorkItem = {
      workItemId: input.workItemId,
      missionId: input.missionId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      acceptanceCriteria: [...input.acceptanceCriteria],
      status: 'queued',
      dependencies: input.dependencies,
      repo: input.repo,
      worktree: input.worktree,
      allowedRuntimeTypes: input.allowedRuntimeTypes,
      allowedRoles: input.allowedRoles,
      createdAt,
    };
    this.workItems.set(workItem.workItemId, workItem);
    this.ledger.upsertWorkItem(workItemRecord(workItem));
    return {
      requestId: request.requestId,
      decision: 'accepted',
      workItem: clone(workItem),
      acceptedAt: createdAt,
    };
  }

  private assignWorkItem(request: FleetControlRequest): FleetControlResponse {
    if (request.mode === 'observe' || request.mode === 'suggest') {
      return {
        requestId: request.requestId,
        decision: 'approval_required',
        reason: 'WorkItem assignment is a side effect and requires approve or autonomous mode.',
      };
    }
    const mission = this.missions.get(request.missionId!);
    if (!mission) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Mission not found.',
      };
    }
    const workItem = this.workItems.get(request.workItemId!);
    if (!workItem || workItem.missionId !== mission.missionId) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'WorkItem not found or does not belong to the Mission.',
      };
    }
    const instance = this.instances.get(request.instanceId!);
    if (!instance) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Instance not found.',
      };
    }
    if (workItem.assignedInstanceId) {
      return workItem.assignedInstanceId === instance.instanceId
        ? {
            requestId: request.requestId,
            decision: 'accepted',
            workItem: clone(workItem),
            instance: clone(instance),
            acceptedAt: this.now(),
          }
        : {
            requestId: request.requestId,
            decision: 'rejected',
            reason: 'WorkItem is already assigned to another instance.',
          };
    }
    if (['stopped', 'error'].includes(instance.status)) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Stopped or error instances cannot receive new WorkItems.',
      };
    }
    if (instance.workItemId && instance.workItemId !== workItem.workItemId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Instance already has an assigned WorkItem.',
      };
    }
    const incomplete = (workItem.dependencies ?? []).find((dependencyId) => {
      const dependency = this.workItems.get(dependencyId);
      return !dependency || dependency.status !== 'completed';
    });
    if (incomplete) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'WorkItem dependency is not completed: ' + incomplete,
      };
    }
    if (
      (workItem.allowedRuntimeTypes && !workItem.allowedRuntimeTypes.includes(instance.runtime)) ||
      (workItem.allowedRoles && !workItem.allowedRoles.includes(instance.role))
    ) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Instance runtime or role is outside the WorkItem constraints.',
      };
    }

    const assignedAt = this.now();
    const updatedWorkItem: WorkItem = {
      ...workItem,
      status: 'active',
      assignedInstanceId: instance.instanceId,
      startedAt: workItem.startedAt ?? assignedAt,
    };
    const updatedInstance: FleetInstance = {
      ...instance,
      missionId: mission.missionId,
      workItemId: workItem.workItemId,
      status: instance.status === 'idle' ? 'working' : instance.status,
      lastActivityAt: assignedAt,
    };
    this.workItems.set(updatedWorkItem.workItemId, updatedWorkItem);
    this.instances.set(updatedInstance.instanceId, updatedInstance);
    const activeMission: Mission = {
      ...mission,
      status: mission.status === 'planned' ? 'active' : mission.status,
      startedAt: mission.startedAt ?? assignedAt,
    };
    this.missions.set(activeMission.missionId, activeMission);
    this.ledger.upsertMission({
      missionId: activeMission.missionId,
      title: activeMission.title,
      objective: activeMission.objective,
      status: activeMission.status,
      coordinatorId: activeMission.coordinator?.instanceId ?? request.requestedBy,
      repoScope: activeMission.repoScope,
      createdAt: activeMission.createdAt,
      startedAt: activeMission.startedAt,
      completedAt: activeMission.completedAt,
    });
    this.ledger.upsertWorkItem(workItemRecord(updatedWorkItem));
    this.ledger.recordAssignment({
      decisionId: 'assignment-' + request.requestId,
      missionId: mission.missionId,
      workItemId: workItem.workItemId,
      action: 'assign_existing',
      candidateInstanceIds: [instance.instanceId],
      selectedInstanceId: instance.instanceId,
      policyMode: request.mode,
      approval: 'approved',
      strategyVersion: 'control-plane-v1',
      rationale: 'Explicit Coordinator assignment.',
      createdAt: assignedAt,
      decidedAt: assignedAt,
      source: 'user',
      availability: 'available',
      confidence: 'exact',
      estimateOrActual: 'actual',
    });
    return {
      requestId: request.requestId,
      decision: 'accepted',
      workItem: clone(updatedWorkItem),
      instance: clone(updatedInstance),
      acceptedAt: assignedAt,
    };
  }

  private collectResult(request: FleetControlRequest): FleetControlResponse {
    const input = request.result!;
    const hintedInstance = input.instanceId ? this.instances.get(input.instanceId) : undefined;
    const historicalWorkItem = input.instanceId
      ? [...this.workItems.values()].find(
          (candidate) => candidate.result?.instanceId === input.instanceId,
        )
      : undefined;
    const correlatedWorkItemId =
      request.workItemId ??
      input.workItemId ??
      hintedInstance?.workItemId ??
      historicalWorkItem?.workItemId;
    const workItem = correlatedWorkItemId ? this.workItems.get(correlatedWorkItemId) : undefined;
    if (!workItem) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'WorkItem could not be correlated from the result or assigned instance.',
      };
    }
    const instanceId = input.instanceId ?? workItem.assignedInstanceId;
    if (!instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Result requires an instanceId or an assigned WorkItem instance.',
      };
    }
    if (workItem.assignedInstanceId && workItem.assignedInstanceId !== instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Result instanceId does not match the assigned instance.',
      };
    }
    const instance = this.instances.get(instanceId);
    if (instance?.workItemId && instance.workItemId !== workItem.workItemId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Result instance is currently assigned to another WorkItem.',
      };
    }
    if (workItem.result) {
      return sameResult(workItem.result, {
        workItemId: workItem.workItemId,
        instanceId,
        outcome: input.outcome,
        summary: input.summary?.trim() || undefined,
        artifactRefs: input.artifactRefs?.map((ref) => ref.trim()).filter(Boolean),
        capturedAt: input.capturedAt ?? workItem.result.capturedAt,
        source: input.source ?? 'runtime',
        availability: input.availability ?? 'available',
        confidence: input.confidence ?? 'medium',
      })
        ? {
            requestId: request.requestId,
            decision: 'accepted',
            workItem: clone(workItem),
            result: clone(workItem.result),
            instance: instance ? clone(instance) : undefined,
            acceptedAt: workItem.result.capturedAt,
          }
        : {
            requestId: request.requestId,
            decision: 'rejected',
            reason: 'WorkItem already has a different terminal result.',
          };
    }
    const capturedAt = input.capturedAt ?? this.now();
    const result: WorkItemResult = {
      workItemId: workItem.workItemId,
      instanceId,
      outcome: input.outcome,
      summary: input.summary?.trim() || undefined,
      artifactRefs: input.artifactRefs?.map((ref) => ref.trim()).filter(Boolean),
      capturedAt,
      source: input.source ?? 'runtime',
      availability: input.availability ?? 'available',
      confidence: input.confidence ?? 'medium',
    };
    const updatedWorkItem: WorkItem = {
      ...workItem,
      status: input.outcome === 'completed' ? 'completed' : 'blocked',
      result,
      completedAt: capturedAt,
    };
    this.workItems.set(updatedWorkItem.workItemId, updatedWorkItem);
    this.ledger.upsertWorkItem(workItemRecord(updatedWorkItem));
    let updatedInstance: FleetInstance | undefined;
    if (instance && instance.workItemId === workItem.workItemId) {
      updatedInstance = {
        ...instance,
        workItemId: undefined,
        status: input.outcome === 'completed' ? 'idle' : 'error',
        lastActivityAt: capturedAt,
      };
      this.instances.set(instanceId, updatedInstance);
    }
    return {
      requestId: request.requestId,
      decision: 'accepted',
      workItem: clone(updatedWorkItem),
      result: clone(result),
      instance: updatedInstance ? clone(updatedInstance) : undefined,
      acceptedAt: capturedAt,
    };
  }

  private async deliverWorkItem(request: FleetControlRequest): Promise<FleetControlResponse> {
    if (request.mode === 'observe' || request.mode === 'suggest') {
      return {
        requestId: request.requestId,
        decision: 'approval_required',
        reason: 'Task delivery is a side effect and requires approve or autonomous mode.',
      };
    }
    const workItem = this.workItems.get(request.workItemId!);
    const instance = this.instances.get(request.instanceId!);
    if (!workItem || workItem.missionId !== request.missionId) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'WorkItem not found or does not belong to the Mission.',
      };
    }
    if (!instance || workItem.assignedInstanceId !== instance.instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'WorkItem must be assigned to the requested instance before delivery.',
      };
    }
    const registration = this.registrations.get(instance.runtime);
    if (!registration) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'No runtime host is registered for task delivery.',
      };
    }
    const delivery = await deliverRuntimeTask(registration.host, {
      instanceId: instance.instanceId,
      task: {
        workItemId: workItem.workItemId,
        title: workItem.title,
        objective: workItem.objective,
        acceptanceCriteria: workItem.acceptanceCriteria,
      },
    });
    if (delivery.status !== 'delivered') {
      return {
        requestId: request.requestId,
        decision: delivery.status === 'rejected' ? 'rejected' : 'unavailable',
        reason: delivery.reason ?? 'Task delivery was not completed.',
        delivery,
      };
    }
    return {
      requestId: request.requestId,
      decision: 'accepted',
      instance: clone(instance),
      workItem: clone(workItem),
      delivery,
      acceptedAt: delivery.deliveredAt ?? this.now(),
    };
  }

  private async invokeCoordinatorSession(
    request: FleetControlRequest,
  ): Promise<FleetControlResponse> {
    const session = this.coordinatorSessions.get(request.coordinatorSession!.sessionId);
    if (!session) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Coordinator session is not registered.',
      };
    }
    return session.invoke(coordinatorSessionRequestFromControl(request));
  }

  private recordTelemetry(request: FleetControlRequest): FleetControlResponse {
    try {
      const usage = request.telemetry?.usage;
      const quota = request.telemetry?.quota;
      if (usage) this.ledger.recordUsage(usage);
      if (quota) this.ledger.recordQuota(quota);
      return {
        requestId: request.requestId,
        decision: 'accepted',
        telemetry: { usageId: usage?.usageId, snapshotId: quota?.snapshotId },
        acceptedAt: this.now(),
      };
    } catch (error) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Telemetry rejected: ' + safeError(error),
      };
    }
  }

  private recordQuality(request: FleetControlRequest): FleetControlResponse {
    try {
      const quality = request.quality!;
      this.ledger.recordQuality({
        ...quality,
        metadata: quality.metadata ? { ...quality.metadata } : undefined,
      });
      return {
        requestId: request.requestId,
        decision: 'accepted',
        quality: clone(quality),
        acceptedAt: this.now(),
      };
    } catch (error) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Quality evidence rejected: ' + safeError(error),
      };
    }
  }

  private async launch(request: FleetControlRequest): Promise<FleetControlResponse> {
    const template = request.launch!;
    if (request.mode === 'observe' || request.mode === 'suggest') {
      return {
        requestId: request.requestId,
        decision: 'approval_required',
        reason: 'Launch is a side effect and requires approve or autonomous mode.',
      };
    }
    if (request.mode === 'approve' && !['approve', 'autonomous'].includes(template.policy.mode)) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Approve requests require an approve or autonomous launch policy.',
      };
    }

    const policyError = this.checkPolicy(template);
    if (policyError) {
      return {
        requestId: request.requestId,
        decision: policyError.kind,
        reason: policyError.reason,
      };
    }

    const registration = this.registrations.get(template.runtime);
    if (!registration) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'No RuntimeAdapter/FleetRuntimeHost is registered for ' + template.runtime + '.',
      };
    }
    if (!registration.adapter.capabilities.launch) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'RuntimeAdapter does not support launch for ' + template.runtime + '.',
      };
    }

    let detected: boolean;
    try {
      detected = await registration.adapter.detect();
    } catch (error) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Runtime detection failed: ' + safeError(error),
      };
    }
    if (!detected) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Runtime is not available: ' + template.runtime + '.',
      };
    }

    const instanceId = request.instanceId ?? 'instance-' + request.requestId;
    const createdAt = this.now();
    const instance: FleetInstance = {
      instanceId,
      runtime: template.runtime,
      role: template.role,
      managedByFleet: true,
      displayName: template.displayName,
      missionId: request.missionId,
      workItemId: request.workItemId,
      hostId: template.hostId ?? registration.host.hostId,
      workspaceId: template.workspaceId ?? template.cwd,
      repo: template.repo,
      worktree: template.worktree,
      branch: template.branch,
      terminalName:
        template.terminalPolicy === 'reuse' ? undefined : template.runtime + '-' + instanceId,
      launchSource: template.launchSource ?? 'fleet-control-api',
      requestedBy: request.requestedBy,
      providerProfileId: template.providerProfileId,
      modelId: template.modelId,
      status: 'starting',
      createdAt,
      lastActivityAt: createdAt,
    };
    const launchRequest: RuntimeLaunchRequest = {
      instance,
      cwd: template.cwd,
      sessionMode: template.sessionMode ?? 'new',
      sessionId: template.sessionId,
      providerProfileId: template.providerProfileId,
      modelId: template.modelId,
      terminalName: instance.terminalName,
      launchSource: instance.launchSource,
      requestedBy: request.requestedBy,
    };

    try {
      const result = await registration.host.launch(launchRequest);
      if (result.instanceId !== instanceId) {
        return {
          requestId: request.requestId,
          decision: 'unavailable',
          reason: 'Runtime host returned a mismatched instanceId.',
        };
      }

      const started = {
        ...instance,
        sessionId: result.sessionId ?? instance.sessionId,
        terminalId: result.terminalId ?? instance.terminalId,
        terminalName: result.terminalName ?? instance.terminalName,
        hostId: result.hostId ?? instance.hostId,
        workspaceId: result.workspaceId ?? instance.workspaceId,
        launchSource: result.launchSource ?? instance.launchSource,
        requestedBy: result.requestedBy ?? instance.requestedBy,
        lastActivityAt: result.startedAt,
      } satisfies FleetInstance;
      this.instances.set(instanceId, started);
      this.ledger.recordLaunch({
        launchId: 'launch-' + request.requestId,
        instanceId,
        sessionId: started.sessionId,
        runtime: template.runtime,
        managedByFleet: true,
        hostId: started.hostId,
        workspaceId: started.workspaceId,
        workspacePath: template.cwd,
        repo: template.repo,
        worktree: template.worktree,
        terminalId: started.terminalId,
        terminalName: started.terminalName,
        launchSource: 'fleet-control-api',
        requestedBy: request.requestedBy,
        sessionMode: launchRequest.sessionMode,
        result: 'started',
        createdAt,
        completedAt: result.startedAt,
      });
      if (started.sessionId) {
        this.ledger.upsertSession({
          sessionId: started.sessionId,
          instanceId,
          runtime: started.runtime,
          managedByFleet: true,
          missionId: started.missionId,
          workItemId: started.workItemId,
          hostId: started.hostId,
          workspaceId: started.workspaceId,
          workspacePath: template.cwd,
          repo: started.repo,
          worktree: started.worktree,
          terminalId: started.terminalId,
          terminalName: started.terminalName,
          providerProfileId: started.providerProfileId,
          modelId: started.modelId,
          status: 'starting',
          launchSource: started.launchSource,
          requestedBy: started.requestedBy,
          startedAt: result.startedAt,
        });
      }
      return {
        requestId: request.requestId,
        decision: 'accepted',
        instance: clone(started),
        launchResult: { ...result },
        acceptedAt: result.startedAt,
      };
    } catch (error) {
      this.ledger.recordLaunch({
        launchId: 'launch-' + request.requestId,
        instanceId,
        runtime: template.runtime,
        managedByFleet: true,
        hostId: instance.hostId,
        workspaceId: instance.workspaceId,
        workspacePath: template.cwd,
        repo: template.repo,
        worktree: template.worktree,
        terminalName: instance.terminalName,
        launchSource: 'fleet-control-api',
        requestedBy: request.requestedBy,
        sessionMode: launchRequest.sessionMode,
        result: 'failed',
        createdAt,
        completedAt: this.now(),
        error: { message: safeError(error), source: 'system', observedAt: this.now() },
      });
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Runtime launch failed: ' + safeError(error),
      };
    }
  }

  private getStatus(request: FleetControlRequest): FleetControlResponse {
    if (!request.instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'instanceId is required.',
      };
    }
    const instance = this.instances.get(request.instanceId);
    return instance
      ? {
          requestId: request.requestId,
          decision: 'accepted',
          instance: clone(instance),
          acceptedAt: this.now(),
        }
      : { requestId: request.requestId, decision: 'unavailable', reason: 'Instance not found.' };
  }

  private recommendAssignment(request: FleetControlRequest): FleetControlResponse {
    const strategyInput = request.strategy!;
    const storedWorkItem = this.workItems.get(strategyInput.workItem.workItemId);
    if (!storedWorkItem) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'WorkItem not found.',
      };
    }
    if (request.missionId && request.missionId !== storedWorkItem.missionId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Mission does not match the WorkItem.',
      };
    }

    const recommendation = this.strategy.recommend({
      ...strategyInput,
      workItem: clone(storedWorkItem),
      candidates:
        strategyInput.candidates && strategyInput.candidates.length > 0
          ? strategyInput.candidates
          : this.listInstances().map((instance) => ({ instance })),
      now: this.now(),
    });
    this.ledger.recordAssignment({
      decisionId: recommendation.recommendationId,
      missionId: recommendation.missionId,
      workItemId: recommendation.workItemId,
      action: recommendation.action,
      candidateInstanceIds: recommendation.candidateInstanceIds,
      selectedInstanceId: recommendation.selectedInstanceId,
      launchTemplate: recommendation.proposedLaunchTemplate,
      policyMode: request.mode,
      approval: ['assign_existing', 'launch_new'].includes(recommendation.action)
        ? 'pending'
        : 'not_required',
      strategyVersion: recommendation.strategyVersion,
      rationale: recommendation.factors.map((factor) => factor.detail).join(' '),
      createdAt: this.now(),
      expected: recommendation.expected,
      source: 'strategy',
      availability: 'available',
      confidence: recommendation.confidence,
      estimateOrActual: 'estimate',
    });
    return {
      requestId: request.requestId,
      decision: 'accepted',
      recommendation: clone(recommendation),
      acceptedAt: this.now(),
    };
  }

  private async focus(request: FleetControlRequest): Promise<FleetControlResponse> {
    return this.runInstanceCommand(request, 'focus', (registration, instance) =>
      registration.host.focus(instance.instanceId),
    );
  }

  private async stop(request: FleetControlRequest): Promise<FleetControlResponse> {
    const response = await this.runInstanceCommand(request, 'stop', (registration, instance) =>
      registration.host.stop(instance.instanceId),
    );
    if (response.decision === 'accepted' && request.instanceId) {
      const previous = this.instances.get(request.instanceId);
      if (previous) {
        const stopped = { ...previous, status: 'stopped' as const, lastActivityAt: this.now() };
        this.instances.set(request.instanceId, stopped);
        if (stopped.sessionId) {
          const session = this.ledger.getSession(stopped.sessionId);
          if (session)
            this.ledger.upsertSession({
              ...session,
              status: 'stopped',
              endedAt: stopped.lastActivityAt,
            });
        }
        response.instance = clone(stopped);
      }
    }
    return response;
  }

  private restart(request: FleetControlRequest): Promise<FleetControlResponse> {
    return this.relaunch(request, true);
  }

  private resume(request: FleetControlRequest): Promise<FleetControlResponse> {
    return this.relaunch(request, false);
  }

  /** Relaunch through the host so the VS Code/CLI terminal boundary remains authoritative. */
  private async relaunch(
    request: FleetControlRequest,
    stopBeforeLaunch: boolean,
  ): Promise<FleetControlResponse> {
    if (request.mode === 'observe' || request.mode === 'suggest') {
      return {
        requestId: request.requestId,
        decision: 'approval_required',
        reason:
          (stopBeforeLaunch ? 'restart' : 'resume') +
          ' is a side effect and requires approve or autonomous mode.',
      };
    }
    if (!request.instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'instanceId is required.',
      };
    }
    const previous = this.instances.get(request.instanceId);
    if (!previous) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Instance not found.',
      };
    }
    if (!previous.sessionId) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Instance has no resumable session.',
      };
    }
    if (!stopBeforeLaunch && !['stopped', 'error', 'idle', 'waiting'].includes(previous.status)) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'Resume requires a stopped, idle, waiting, or error instance.',
      };
    }
    const registration = this.registrations.get(previous.runtime);
    if (!registration) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'No runtime host is registered.',
      };
    }
    const cwd = previous.workspaceId ?? previous.repo;
    if (!cwd) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Instance has no resumable workspace.',
      };
    }

    try {
      if (stopBeforeLaunch && previous.status !== 'stopped') {
        await registration.host.stop(previous.instanceId);
      }
      const starting: FleetInstance = {
        ...previous,
        status: 'starting',
        lastActivityAt: this.now(),
      };
      const result = await registration.host.launch({
        instance: starting,
        cwd,
        sessionMode: 'resume',
        sessionId: previous.sessionId,
        providerProfileId: previous.providerProfileId,
        modelId: previous.modelId,
        terminalName: previous.terminalName,
        launchSource: 'fleet-control-api',
        requestedBy: request.requestedBy,
      });
      if (result.instanceId !== previous.instanceId) {
        return {
          requestId: request.requestId,
          decision: 'unavailable',
          reason: 'Runtime host returned a mismatched instanceId.',
        };
      }

      const resumed: FleetInstance = {
        ...starting,
        sessionId: result.sessionId ?? previous.sessionId,
        terminalId: result.terminalId ?? previous.terminalId,
        terminalName: result.terminalName ?? previous.terminalName,
        hostId: result.hostId ?? previous.hostId,
        workspaceId: result.workspaceId ?? previous.workspaceId,
        launchSource: result.launchSource ?? 'fleet-control-api',
        requestedBy: result.requestedBy ?? request.requestedBy,
        lastActivityAt: result.startedAt,
      };
      this.instances.set(previous.instanceId, resumed);
      this.ledger.recordLaunch({
        launchId: 'launch-' + request.requestId,
        instanceId: resumed.instanceId,
        sessionId: resumed.sessionId,
        runtime: resumed.runtime,
        managedByFleet: resumed.managedByFleet,
        hostId: resumed.hostId,
        workspaceId: resumed.workspaceId,
        workspacePath: cwd,
        repo: resumed.repo,
        worktree: resumed.worktree,
        terminalId: resumed.terminalId,
        terminalName: resumed.terminalName,
        launchSource: 'fleet-control-api',
        requestedBy: request.requestedBy,
        sessionMode: 'resume',
        result: 'started',
        createdAt: starting.lastActivityAt ?? this.now(),
        completedAt: result.startedAt,
      });
      if (resumed.sessionId) {
        const session = this.ledger.getSession(resumed.sessionId);
        if (session) {
          this.ledger.upsertSession({
            ...session,
            status: 'starting',
            endedAt: undefined,
            startedAt: result.startedAt,
            terminalId: resumed.terminalId,
            terminalName: resumed.terminalName,
            providerProfileId: resumed.providerProfileId,
            modelId: resumed.modelId,
          });
        }
      }
      return {
        requestId: request.requestId,
        decision: 'accepted',
        instance: clone(resumed),
        launchResult: { ...result },
        acceptedAt: result.startedAt,
      };
    } catch (error) {
      const failed = { ...previous, status: 'error' as const, lastActivityAt: this.now() };
      this.instances.set(previous.instanceId, failed);
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: (stopBeforeLaunch ? 'restart' : 'resume') + ' failed: ' + safeError(error),
      };
    }
  }

  private async runInstanceCommand(
    request: FleetControlRequest,
    operation: 'focus' | 'stop',
    command: (registration: FleetRuntimeRegistration, instance: FleetInstance) => Promise<void>,
  ): Promise<FleetControlResponse> {
    if (request.mode === 'observe' || request.mode === 'suggest') {
      return {
        requestId: request.requestId,
        decision: 'approval_required',
        reason: operation + ' is a side effect and requires approve or autonomous mode.',
      };
    }
    if (!request.instanceId) {
      return {
        requestId: request.requestId,
        decision: 'rejected',
        reason: 'instanceId is required.',
      };
    }
    const instance = this.instances.get(request.instanceId);
    if (!instance) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Instance not found.',
      };
    }
    const registration = this.registrations.get(instance.runtime);
    if (!registration) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'No runtime host is registered.',
      };
    }
    try {
      await command(registration, instance);
      return {
        requestId: request.requestId,
        decision: 'accepted',
        instance: clone(instance),
        acceptedAt: this.now(),
      };
    } catch (error) {
      return {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: operation + ' failed: ' + safeError(error),
      };
    }
  }

  private checkPolicy(
    template: FleetLaunchTemplate,
  ): { kind: 'rejected' | 'unavailable'; reason: string } | null {
    const policy = template.policy;
    if (policy.allowedRuntimeTypes && !policy.allowedRuntimeTypes.includes(template.runtime)) {
      return { kind: 'rejected', reason: 'Runtime is outside the approved policy.' };
    }
    if (policy.allowedRoles && !policy.allowedRoles.includes(template.role)) {
      return { kind: 'rejected', reason: 'Role is outside the approved policy.' };
    }
    if (
      policy.allowedProviderProfileIds &&
      !policy.allowedProviderProfileIds.includes(template.providerProfileId ?? '')
    ) {
      return { kind: 'rejected', reason: 'Provider profile is outside the approved policy.' };
    }
    if (policy.allowedRepositories && !policy.allowedRepositories.includes(template.repo)) {
      return { kind: 'rejected', reason: 'Repository is outside the approved policy.' };
    }
    const active = [...this.instances.values()].filter(
      (instance) => !['stopped', 'error'].includes(instance.status),
    ).length;
    if (policy.maxConcurrentInstances !== undefined && active >= policy.maxConcurrentInstances) {
      return { kind: 'rejected', reason: 'Maximum concurrent instance limit reached.' };
    }
    if (policy.quotaReserve !== undefined && this.ledger.listQuota().length === 0) {
      return {
        kind: 'unavailable',
        reason: 'Quota reserve cannot be evaluated without a quota snapshot.',
      };
    }
    if (policy.maxTokenBudget !== undefined) {
      const used = this.ledger
        .listUsage()
        .reduce((sum, record) => sum + (record.tokens?.totalTokens ?? 0), 0);
      if (used >= policy.maxTokenBudget) {
        return { kind: 'rejected', reason: 'Token budget is exhausted.' };
      }
    }
    if (policy.maxCostBudget !== undefined) {
      const costs = this.ledger
        .listUsage()
        .map((record) => record.cost)
        .filter((cost): cost is NonNullable<typeof cost> => cost !== undefined);
      const currencies = new Set(costs.map((cost) => cost.currency));
      if (currencies.size > 1) {
        return {
          kind: 'unavailable',
          reason: 'Cost budget cannot be evaluated across multiple currencies.',
        };
      }
      const used = costs.reduce((sum, cost) => sum + cost.amount, 0);
      if (used >= policy.maxCostBudget) {
        return { kind: 'rejected', reason: 'Cost budget is exhausted.' };
      }
    }
    return null;
  }

  private finish(
    request: FleetControlRequest,
    response: FleetControlResponse,
  ): FleetControlResponse {
    const completedAt = this.now();
    this.ledger.recordControlDecision({
      decisionId: 'decision-' + request.requestId,
      requestId: request.requestId,
      action: request.action,
      decision: response.decision,
      mode: request.mode,
      requestedBy: request.requestedBy,
      missionId: request.missionId,
      workItemId: request.workItemId,
      instanceId: response.instance?.instanceId ?? request.instanceId,
      runtime: request.launch?.runtime ?? response.instance?.runtime,
      reason: response.reason,
      createdAt: request.createdAt,
      completedAt,
      source: 'system',
      availability: 'available',
      confidence: 'exact',
      estimateOrActual: 'actual',
    });
    const saved = { ...response };
    this.responses.set(request.requestId, clone(saved));
    return clone(saved);
  }
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*(?:Bearer\s+)?\S+/gi,
      '[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .slice(0, 512);
}

function addTokenUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (!next) return total;
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = next[key];
    if (value !== undefined) total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

function aggregateCost(records: UsageRecord[]): CostAmount | undefined {
  const costs = records
    .map((record) => record.cost)
    .filter((cost): cost is CostAmount => cost !== undefined);
  if (costs.length === 0) return undefined;
  const first = costs[0];
  if (costs.some((cost) => cost.currency !== first.currency || cost.basis !== first.basis)) {
    return undefined;
  }
  return {
    amount: costs.reduce((total, cost) => total + cost.amount, 0),
    currency: first.currency,
    basis: first.basis,
  };
}

/**
 * Keep every raw turn in `usage`, but select one contribution per session for
 * totals. Native runtime scans are cumulative snapshots; counting all of them
 * would multiply a session every time the scanner polls it.
 */
function selectUsageForAggregation(records: UsageRecord[]): UsageRecord[] {
  const unscoped: UsageRecord[] = [];
  const bySession = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (!record.sessionId) unscoped.push(record);
    else bySession.set(record.sessionId, [...(bySession.get(record.sessionId) ?? []), record]);
  }
  const selected = [...unscoped];
  for (const sessionRecords of bySession.values()) {
    const cumulative = sessionRecords.filter(
      (record) => record.aggregation === 'session-cumulative',
    );
    if (cumulative.length > 0) {
      selected.push(
        cumulative.reduce((latest, record) =>
          record.capturedAt > latest.capturedAt ? record : latest,
        ),
      );
      continue;
    }
    selected.push(...sessionRecords);
  }
  return selected;
}

function aggregateCosts(records: UsageRecord[]): UsageCostBreakdown | undefined {
  const apiEquivalent = aggregateCostValues(records.map((record) => record.costs?.apiEquivalent));
  const metered = aggregateCostValues(records.map((record) => record.costs?.metered));
  const subscription = aggregateSubscriptionAllocation(
    records
      .map((record) => record.costs?.subscription)
      .filter((value): value is SubscriptionCostAllocation => value !== undefined),
  );
  if (!apiEquivalent && !metered && !subscription) return undefined;
  return {
    ...(apiEquivalent ? { apiEquivalent } : {}),
    ...(metered ? { metered } : {}),
    ...(subscription ? { subscription } : {}),
  };
}

function aggregateSubscriptionAllocation(
  values: SubscriptionCostAllocation[],
): SubscriptionCostAllocation | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  if (
    values.some(
      (value) =>
        value.currency !== first.currency ||
        value.billingPeriod !== first.billingPeriod ||
        value.periodPrice !== first.periodPrice ||
        value.priceSource !== first.priceSource ||
        value.planType !== first.planType ||
        value.resourceAccountId !== first.resourceAccountId,
    )
  ) {
    return undefined;
  }
  return {
    ...first,
    amount: values.reduce((total, value) => total + value.amount, 0),
    fractionOfPeriod: values.reduce((total, value) => total + value.fractionOfPeriod, 0),
    consumedPercentage: values.reduce((total, value) => total + value.consumedPercentage, 0),
    confidence: lowestConfidence(values),
    availability: values.some((value) => value.availability === 'available')
      ? 'available'
      : 'partial',
    estimateOrActual: values.some((value) => value.estimateOrActual === 'estimate')
      ? 'estimate'
      : 'actual',
  };
}

function aggregateTotalCosts(
  records: UsageRecord[],
): NonNullable<FleetMetricsSnapshot['totals']['costs']> | undefined {
  const apiEquivalent = aggregateCostValues(records.map((record) => record.costs?.apiEquivalent));
  const metered = aggregateCostValues(records.map((record) => record.costs?.metered));
  const subscription = aggregateSubscriptionCost(
    records
      .map((record) => record.costs?.subscription)
      .filter((value): value is SubscriptionCostAllocation => value !== undefined),
  );
  if (!apiEquivalent && !metered && !subscription) return undefined;
  return {
    ...(apiEquivalent ? { apiEquivalent } : {}),
    ...(metered ? { metered } : {}),
    ...(subscription ? { subscription } : {}),
  };
}

function aggregateCostValues(values: Array<CostAmount | undefined>): CostAmount | undefined {
  const costs = values.filter((value): value is CostAmount => value !== undefined);
  if (costs.length === 0) return undefined;
  const first = costs[0];
  if (costs.some((cost) => cost.currency !== first.currency || cost.basis !== first.basis)) {
    return undefined;
  }
  return {
    amount: costs.reduce((total, cost) => total + cost.amount, 0),
    currency: first.currency,
    basis: first.basis,
  };
}

function aggregateSubscriptionCost(
  values: SubscriptionCostAllocation[],
): SubscriptionCostAggregate | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  if (values.some((value) => value.currency !== first.currency)) return undefined;
  return {
    amount: values.reduce((total, value) => total + value.amount, 0),
    currency: first.currency,
    basis: 'subscription-amortized',
    fractionOfPeriod: values.reduce((total, value) => total + value.fractionOfPeriod, 0),
    consumedPercentage: values.reduce((total, value) => total + value.consumedPercentage, 0),
    records: values.length,
    planTypes: [...new Set(values.map((value) => value.planType).filter(Boolean) as string[])],
  };
}

function aggregateQuotaUsage(records: UsageRecord[]): QuotaUsageAggregate[] {
  const groups = new Map<string, QuotaUsageAggregate>();
  for (const record of records) {
    const impact = record.quotaImpact;
    if (!impact) continue;
    const key = [
      impact.resourceAccountId ?? '-',
      impact.planType ?? '-',
      impact.billingMode ?? '-',
      impact.window,
    ].join('|');
    const previous = groups.get(key);
    const next: QuotaUsageAggregate = {
      resourceAccountId: impact.resourceAccountId,
      planType: impact.planType,
      billingMode: impact.billingMode,
      window: impact.window,
      consumedPercentage: (previous?.consumedPercentage ?? 0) + (impact.consumedPercentage ?? 0),
      fractionOfWindow: (previous?.fractionOfWindow ?? 0) + (impact.fractionOfWindow ?? 0),
      records: (previous?.records ?? 0) + 1,
    };
    groups.set(key, next);
  }
  return [...groups.values()];
}

function lowestConfidence(
  records: Array<Pick<UsageRecord, 'confidence'>>,
): UsageRecord['confidence'] {
  const order: UsageRecord['confidence'][] = ['unknown', 'low', 'medium', 'high', 'exact'];
  return records.reduce<UsageRecord['confidence']>(
    (lowest, record) =>
      order.indexOf(record.confidence) < order.indexOf(lowest) ? record.confidence : lowest,
    'exact',
  );
}

function normalizeLiveTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: TokenUsage = {};
  for (const [sourceKey, targetKey] of [
    ['inputTokens', 'inputTokens'],
    ['cachedInputTokens', 'cachedInputTokens'],
    ['outputTokens', 'outputTokens'],
    ['totalTokens', 'totalTokens'],
  ] as const) {
    const candidate = source[sourceKey];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      result[targetKey] = candidate;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sessionStatusForFleetStatus(status: FleetInstance['status']): SessionStatus {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'waiting':
      return 'waiting';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    case 'working':
    case 'idle':
    default:
      return 'active';
  }
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameMission(
  existing: Mission,
  input: NonNullable<FleetControlRequest['mission']>,
): boolean {
  return (
    existing.title === input.title.trim() &&
    existing.objective === input.objective.trim() &&
    existing.policyMode === input.policyMode &&
    JSON.stringify(existing.repoScope ?? []) === JSON.stringify(input.repoScope ?? [])
  );
}

function missionFromRecord(record: {
  missionId: string;
  title: string;
  objective: string;
  status: Mission['status'];
  coordinatorId?: string;
  repoScope?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}): Mission {
  return {
    missionId: record.missionId,
    title: record.title,
    objective: record.objective,
    policyMode: 'suggest',
    status: record.status,
    coordinator: record.coordinatorId
      ? { coordinatorId: record.coordinatorId, kind: 'external' }
      : undefined,
    repoScope: record.repoScope,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function workItemFromRecord(record: {
  workItemId: string;
  missionId: string;
  title: string;
  objective: string;
  status: WorkItem['status'];
  acceptanceCriteria: string[];
  dependencyIds?: string[];
  repo?: string;
  worktree?: string;
  assignedInstanceId?: string;
  result?: WorkItemResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}): WorkItem {
  return {
    workItemId: record.workItemId,
    missionId: record.missionId,
    title: record.title,
    objective: record.objective,
    acceptanceCriteria: [...record.acceptanceCriteria],
    status: record.status,
    dependencies: record.dependencyIds,
    repo: record.repo,
    worktree: record.worktree,
    assignedInstanceId: record.assignedInstanceId,
    result: record.result,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function workItemRecord(workItem: WorkItem) {
  return {
    workItemId: workItem.workItemId,
    missionId: workItem.missionId,
    title: workItem.title,
    objective: workItem.objective,
    status: workItem.status,
    acceptanceCriteria: [...workItem.acceptanceCriteria],
    dependencyIds: workItem.dependencies,
    repo: workItem.repo,
    worktree: workItem.worktree,
    assignedInstanceId: workItem.assignedInstanceId,
    result: workItem.result,
    createdAt: workItem.createdAt,
    startedAt: workItem.startedAt,
    completedAt: workItem.completedAt,
  };
}

function sameWorkItem(
  existing: WorkItem,
  input: NonNullable<FleetControlRequest['workItem']>,
): boolean {
  return (
    existing.missionId === input.missionId &&
    existing.title === input.title.trim() &&
    existing.objective === input.objective.trim() &&
    JSON.stringify(existing.acceptanceCriteria) === JSON.stringify(input.acceptanceCriteria) &&
    JSON.stringify(existing.dependencies ?? []) === JSON.stringify(input.dependencies ?? []) &&
    existing.repo === input.repo &&
    existing.worktree === input.worktree
  );
}

function sameResult(left: WorkItemResult, right: WorkItemResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
