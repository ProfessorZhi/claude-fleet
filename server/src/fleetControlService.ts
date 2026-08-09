import {
  type FleetControlApi,
  type FleetControlRequest,
  type FleetControlResponse,
  type FleetLaunchTemplate,
  validateFleetControlRequest,
} from '../../core/src/controlContracts.js';
import type {
  FleetInstance,
  FleetRuntime,
  FleetRuntimeHost,
  Mission,
  RuntimeAdapter,
  RuntimeLaunchRequest,
  WorkItem,
} from '../../core/src/runtimeContracts.js';
import type { StrategyAdapter } from '../../core/src/strategyContracts.js';
import { FleetLedgerStore } from './fleetLedgerStore.js';
import { FleetStrategyAdapter } from './fleetStrategy.js';

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

  private readonly now: () => number;
  private readonly registrations = new Map<FleetRuntime, FleetRuntimeRegistration>();
  private readonly instances = new Map<string, FleetInstance>();
  private readonly missions = new Map<string, Mission>();
  private readonly workItems = new Map<string, WorkItem>();
  private readonly responses = new Map<string, FleetControlResponse>();
  private readonly strategy: StrategyAdapter;

  constructor(options: FleetControlServiceOptions = {}) {
    this.ledger = options.ledger ?? new FleetLedgerStore();
    this.now = options.now ?? (() => Date.now());
    this.strategy = options.strategy ?? new FleetStrategyAdapter();
    for (const registration of options.registrations ?? []) this.registerRuntime(registration);
    for (const instance of options.instances ?? [])
      this.instances.set(instance.instanceId, clone(instance));
    for (const mission of options.missions ?? [])
      this.missions.set(mission.missionId, clone(mission));
    for (const workItem of options.workItems ?? [])
      this.workItems.set(workItem.workItemId, clone(workItem));
  }

  registerRuntime(registration: FleetRuntimeRegistration): void {
    this.registrations.set(registration.adapter.runtime, registration);
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
        response = this.createWorkItem(request);
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
      case 'resume_instance':
      case 'collect_result':
        response = {
          requestId: request.requestId,
          decision: 'unavailable',
          reason: request.action + ' requires its dedicated record/host extension.',
        };
        break;
      case 'recommend_assignment':
        response = this.recommendAssignment(request);
        break;
    }

    return this.finish(request, response);
  }

  async getInstance(instanceId: string): Promise<FleetInstance | undefined> {
    return clone(this.instances.get(instanceId));
  }

  /** Register or refresh a runtime snapshot supplied by the host/discovery layer. */
  upsertInstance(instance: FleetInstance): void {
    this.instances.set(instance.instanceId, clone(instance));
  }

  /** Preserve a stopped instance in management history without deleting it. */
  markInstanceStopped(instanceId: string, observedAt = this.now()): void {
    const previous = this.instances.get(instanceId);
    if (!previous) return;
    this.instances.set(
      instanceId,
      clone({ ...previous, status: 'stopped', lastActivityAt: observedAt }),
    );
  }

  listInstances(): FleetInstance[] {
    return [...this.instances.values()].map((instance) => clone(instance));
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return clone(this.missions.get(missionId));
  }

  async getWorkItem(workItemId: string): Promise<WorkItem | undefined> {
    return clone(this.workItems.get(workItemId));
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

  private createWorkItem(request: FleetControlRequest): FleetControlResponse {
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
    this.ledger.upsertWorkItem({
      workItemId: workItem.workItemId,
      missionId: workItem.missionId,
      title: workItem.title,
      objective: workItem.objective,
      status: workItem.status,
      acceptanceCriteria: workItem.acceptanceCriteria,
      dependencyIds: workItem.dependencies,
      repo: workItem.repo,
      worktree: workItem.worktree,
      createdAt,
    });
    return {
      requestId: request.requestId,
      decision: 'accepted',
      workItem: clone(workItem),
      acceptedAt: createdAt,
    };
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

function clone<T>(value: T): T {
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
