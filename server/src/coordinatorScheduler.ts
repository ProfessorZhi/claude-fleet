import type {
  FleetControlApi,
  FleetControlPolicy,
  FleetControlRequest,
  FleetControlResponse,
  FleetLaunchTemplate,
} from '../../core/src/controlContracts.js';
import type { AssignmentAction } from '../../core/src/ledgerContracts.js';
import type { FleetControlMode, FleetInstance, WorkItem } from '../../core/src/runtimeContracts.js';
import type { StrategyRecommendation } from '../../core/src/strategyContracts.js';

export type CoordinatorWorkItemSource = WorkItem[] | (() => WorkItem[] | Promise<WorkItem[]>);

export interface CoordinatorSchedulerRetryPolicy {
  /** Maximum number of control attempts for one WorkItem. */
  maxAttempts?: number;
  /** Delay before the first retry. A tick never sleeps; it returns this time. */
  initialBackoffMs?: number;
  /** Upper bound for exponential retry backoff. */
  maxBackoffMs?: number;
}

export interface CoordinatorSchedulerOptions {
  control: FleetControlApi;
  requestedBy: string;
  /** The source must return full WorkItems, including runtime/role constraints. */
  workItems: CoordinatorWorkItemSource;
  missionId?: string;
  /** Defaults to suggest, which can recommend but cannot assign or launch. */
  policy?: Partial<FleetControlPolicy> & { mode?: FleetControlMode };
  /** Complete templates are required for a launch side effect. */
  launchTemplates?: FleetLaunchTemplate[];
  now?: () => number;
  retry?: CoordinatorSchedulerRetryPolicy;
}

export type CoordinatorPlanItemStatus =
  | 'ready'
  | 'dependency_blocked'
  | 'concurrency_blocked'
  | 'in_progress'
  | 'terminal'
  | 'retry_wait'
  | 'retry_exhausted'
  | 'recommendation_unavailable'
  | 'no_compatible_assignment';

export interface CoordinatorPlanItem {
  workItemId: string;
  missionId: string;
  status: CoordinatorPlanItemStatus;
  attempt: number;
  reason?: string;
  action?: AssignmentAction;
  selectedInstanceId?: string;
  plannedInstanceId?: string;
  launchTemplate?: FleetLaunchTemplate;
  recommendation?: StrategyRecommendation;
  recommendationResponse?: FleetControlResponse;
  nextAttemptAt?: number;
}

export interface CoordinatorSchedulerPlan {
  capturedAt: number;
  missionId?: string;
  policy: FleetControlPolicy;
  items: CoordinatorPlanItem[];
}

export interface CoordinatorSchedulerExecution {
  workItemId: string;
  attempt: number;
  action?: AssignmentAction;
  decision: FleetControlResponse['decision'];
  response?: FleetControlResponse;
  instanceId?: string;
  retryAt?: number;
}

export interface CoordinatorSchedulerTick {
  plan: CoordinatorSchedulerPlan;
  executions: CoordinatorSchedulerExecution[];
  sideEffectsExecuted: boolean;
}

interface AttemptState {
  attempts: number;
  nextAttemptAt?: number;
  pendingInstanceId?: string;
}

/**
 * Local, explicit Coordinator loop.
 *
 * `plan()` only reads state and asks the management plane for a recommendation.
 * `tick()` executes assignment/launch requests only for approve/autonomous
 * policies. It has no timer, process spawning, transcript access, or Runtime
 * implementation of its own.
 */
export class CoordinatorScheduler {
  private readonly control: FleetControlApi;
  private readonly requestedBy: string;
  private readonly readWorkItems: () => Promise<WorkItem[]>;
  private readonly missionId?: string;
  private readonly policy: FleetControlPolicy;
  private readonly launchTemplates: FleetLaunchTemplate[];
  private readonly now: () => number;
  private readonly retry: Required<CoordinatorSchedulerRetryPolicy>;
  private readonly attempts = new Map<string, AttemptState>();
  private readonly responses = new Map<string, FleetControlResponse>();

  constructor(options: CoordinatorSchedulerOptions) {
    if (!options.requestedBy.trim())
      throw new Error('CoordinatorScheduler requestedBy is required.');
    if (!options.workItems) throw new Error('CoordinatorScheduler workItems source is required.');

    this.control = options.control;
    this.requestedBy = options.requestedBy;
    this.readWorkItems = async () =>
      typeof options.workItems === 'function'
        ? clone(await options.workItems())
        : clone(options.workItems);
    this.missionId = options.missionId;
    this.policy = { ...options.policy, mode: options.policy?.mode ?? 'suggest' };
    this.launchTemplates = clone(options.launchTemplates ?? []);
    this.now = options.now ?? (() => Date.now());
    this.retry = normalizeRetryPolicy(options.retry);

    if (
      this.policy.maxConcurrentInstances !== undefined &&
      this.policy.maxConcurrentInstances < 1
    ) {
      throw new Error('CoordinatorScheduler maxConcurrentInstances must be at least 1.');
    }
    for (const template of this.launchTemplates) {
      if (!template.repo.trim() || !template.cwd.trim()) {
        throw new Error('CoordinatorScheduler launch templates require repo and cwd.');
      }
    }
  }

  /** Stable session metadata used by the authenticated Coordinator boundary. */
  get ownerId(): string {
    return this.requestedBy;
  }

  /** The policy is fixed when a scheduler is created; callers cannot change it per tick. */
  get controlPolicy(): FleetControlPolicy {
    return clone(this.policy);
  }

  /** Build a read-only plan. It never assigns or launches an instance. */
  async plan(): Promise<CoordinatorSchedulerPlan> {
    const capturedAt = positiveTimestamp(this.now());
    const workItems = (await this.readWorkItems())
      .filter((workItem) => !this.missionId || workItem.missionId === this.missionId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.workItemId.localeCompare(right.workItemId),
      );
    const instances = await this.control.listInstances();
    const reservedInstanceIds = new Set(
      instances
        .filter(
          (instance) =>
            Boolean(instance.workItemId) || ['starting', 'working'].includes(instance.status),
        )
        .map((instance) => instance.instanceId),
    );
    const activeInstanceCount = instances.filter(
      (instance) => !['stopped', 'error'].includes(instance.status),
    ).length;
    let plannedLaunches = 0;
    const items: CoordinatorPlanItem[] = [];

    for (const workItem of workItems) {
      const state = this.stateFor(workItem.workItemId);
      const base = {
        workItemId: workItem.workItemId,
        missionId: workItem.missionId,
        attempt: state.attempts + 1,
      } satisfies Pick<CoordinatorPlanItem, 'workItemId' | 'missionId' | 'attempt'>;

      if (isTerminal(workItem.status)) {
        items.push({ ...base, status: 'terminal', reason: `WorkItem is ${workItem.status}.` });
        continue;
      }
      if (state.attempts >= this.retry.maxAttempts) {
        items.push({
          ...base,
          status: 'retry_exhausted',
          reason: 'Retry limit reached for this WorkItem.',
        });
        continue;
      }
      if (state.nextAttemptAt !== undefined && state.nextAttemptAt > capturedAt) {
        items.push({
          ...base,
          status: 'retry_wait',
          reason: 'Backoff is active after a transient control failure.',
          nextAttemptAt: state.nextAttemptAt,
        });
        continue;
      }

      const dependencyReason = dependencyBlockReason(workItem, workItems);
      if (dependencyReason) {
        items.push({ ...base, status: 'dependency_blocked', reason: dependencyReason });
        continue;
      }

      const pendingInstanceId = state.pendingInstanceId;
      if (pendingInstanceId) {
        const pending = instances.find((instance) => instance.instanceId === pendingInstanceId);
        if (pending && !['stopped', 'error'].includes(pending.status)) {
          reservedInstanceIds.add(pending.instanceId);
          items.push({
            ...base,
            status: 'ready',
            action: 'assign_existing',
            selectedInstanceId: pending.instanceId,
            plannedInstanceId: pending.instanceId,
            reason:
              workItem.assignedInstanceId === pending.instanceId
                ? 'A previously assigned instance is waiting for idempotent task delivery.'
                : 'A previously launched instance is waiting for idempotent assignment.',
          });
          continue;
        }
        state.pendingInstanceId = undefined;
      }

      if (isInProgress(workItem.status)) {
        items.push({ ...base, status: 'in_progress', reason: `WorkItem is ${workItem.status}.` });
        continue;
      }

      const candidates = instances.filter(
        (instance) =>
          !reservedInstanceIds.has(instance.instanceId) &&
          ['idle', 'waiting'].includes(instance.status) &&
          !instance.workItemId,
      );
      const launchAllowed =
        this.policy.maxConcurrentInstances === undefined ||
        activeInstanceCount + plannedLaunches < this.policy.maxConcurrentInstances;
      if (!launchAllowed && candidates.length === 0) {
        items.push({
          ...base,
          status: 'concurrency_blocked',
          reason: 'No available instance exists within maxConcurrentInstances.',
        });
        continue;
      }

      const compatibleLaunchTemplates = launchAllowed
        ? this.launchTemplates.filter((template) =>
            isLaunchTemplateAllowed(template, workItem, this.policy),
          )
        : [];
      const recommendationResponse = await this.submitRecommendation(
        workItem,
        capturedAt,
        candidates,
        compatibleLaunchTemplates,
        base.attempt,
      );
      if (
        recommendationResponse.decision !== 'accepted' ||
        !recommendationResponse.recommendation
      ) {
        items.push({
          ...base,
          status: 'recommendation_unavailable',
          reason: recommendationResponse.reason ?? 'Recommendation was not accepted.',
          recommendationResponse,
        });
        continue;
      }

      const recommendation = recommendationResponse.recommendation;
      if (recommendation.action === 'assign_existing' && recommendation.selectedInstanceId) {
        reservedInstanceIds.add(recommendation.selectedInstanceId);
        items.push({
          ...base,
          status: 'ready',
          action: recommendation.action,
          selectedInstanceId: recommendation.selectedInstanceId,
          recommendation,
          recommendationResponse,
        });
        continue;
      }
      if (recommendation.action === 'launch_new' && recommendation.proposedLaunchTemplate) {
        const launchTemplate = this.findLaunchTemplate(recommendation.proposedLaunchTemplate);
        if (launchTemplate) {
          const plannedInstanceId = this.instanceIdFor(
            workItem.missionId,
            workItem.workItemId,
            base.attempt,
          );
          plannedLaunches += 1;
          reservedInstanceIds.add(plannedInstanceId);
          items.push({
            ...base,
            status: 'ready',
            action: recommendation.action,
            plannedInstanceId,
            launchTemplate,
            recommendation,
            recommendationResponse,
          });
          continue;
        }
      }

      const concurrencyConstraint = recommendation.constraints.some(
        (constraint) => constraint.key === 'concurrency_limit' && constraint.blocking,
      );
      items.push({
        ...base,
        status: concurrencyConstraint ? 'concurrency_blocked' : 'no_compatible_assignment',
        reason: recommendation.factors.find((factor) => factor.key === 'no_assignment')?.detail,
        recommendation,
        recommendationResponse,
      });
    }

    return { capturedAt, missionId: this.missionId, policy: clone(this.policy), items };
  }

  /** Build a plan, then execute only approved/autonomous assignment actions. */
  async tick(): Promise<CoordinatorSchedulerTick> {
    const plan = await this.plan();
    if (plan.policy.mode === 'observe' || plan.policy.mode === 'suggest') {
      return { plan, executions: [], sideEffectsExecuted: false };
    }

    const executions: CoordinatorSchedulerExecution[] = [];
    let sideEffectsExecuted = false;
    for (const item of plan.items) {
      if (item.status === 'recommendation_unavailable') {
        const response = item.recommendationResponse;
        if (response?.decision === 'unavailable') {
          const retryAt = this.recordFailure(item.workItemId, plan.capturedAt);
          executions.push({
            workItemId: item.workItemId,
            attempt: item.attempt,
            decision: response.decision,
            response,
            retryAt,
          });
        }
        continue;
      }
      if (item.status !== 'ready' || !item.action) continue;
      const execution = await this.execute(item, plan.capturedAt);
      executions.push(execution);
      sideEffectsExecuted = true;
    }
    return { plan, executions, sideEffectsExecuted };
  }

  private async execute(
    item: CoordinatorPlanItem,
    capturedAt: number,
  ): Promise<CoordinatorSchedulerExecution> {
    if (item.action === 'assign_existing') {
      const response = await this.submitOnce({
        requestId: this.requestId(item.workItemId, 'assign', item.attempt),
        action: 'assign_work_item',
        mode: this.policy.mode,
        requestedBy: this.requestedBy,
        missionId: item.missionId,
        workItemId: item.workItemId,
        instanceId: item.selectedInstanceId,
        createdAt: capturedAt,
      });
      if (response.decision !== 'accepted') {
        return this.finishExecution(item, response, capturedAt, item.selectedInstanceId);
      }
      this.stateFor(item.workItemId).pendingInstanceId = item.selectedInstanceId;
      const delivery = await this.submitOnce({
        requestId: this.requestId(item.workItemId, 'deliver', item.attempt),
        action: 'deliver_work_item',
        mode: this.policy.mode,
        requestedBy: this.requestedBy,
        missionId: item.missionId,
        workItemId: item.workItemId,
        instanceId: item.selectedInstanceId,
        createdAt: capturedAt,
      });
      return this.finishExecution(item, delivery, capturedAt, item.selectedInstanceId);
    }

    const instanceId =
      item.plannedInstanceId ?? this.instanceIdFor(item.missionId, item.workItemId, item.attempt);
    const existing = await this.control.getInstance(instanceId);
    let launchResponse: FleetControlResponse;
    if (existing) {
      launchResponse = {
        requestId: this.requestId(item.workItemId, 'launch', item.attempt),
        decision: 'accepted',
        instance: existing,
        acceptedAt: capturedAt,
      };
    } else if (item.launchTemplate) {
      launchResponse = await this.submitOnce({
        requestId: this.requestId(item.workItemId, 'launch', item.attempt),
        action: 'launch_instance',
        mode: this.policy.mode,
        requestedBy: this.requestedBy,
        missionId: item.missionId,
        workItemId: item.workItemId,
        instanceId,
        launch: {
          ...item.launchTemplate,
          requestedBy: item.launchTemplate.requestedBy ?? this.requestedBy,
          policy: { ...this.policy, mode: this.policy.mode },
        },
        createdAt: capturedAt,
      });
    } else {
      return this.finishExecution(
        item,
        {
          requestId: this.requestId(item.workItemId, 'launch', item.attempt),
          decision: 'unavailable',
          reason: 'No complete launch template is available.',
        },
        capturedAt,
        instanceId,
      );
    }

    if (launchResponse.decision !== 'accepted') {
      return this.finishExecution(item, launchResponse, capturedAt, instanceId);
    }
    const state = this.stateFor(item.workItemId);
    state.pendingInstanceId = instanceId;
    const assignment = await this.submitOnce({
      requestId: this.requestId(item.workItemId, 'assign', item.attempt),
      action: 'assign_work_item',
      mode: this.policy.mode,
      requestedBy: this.requestedBy,
      missionId: item.missionId,
      workItemId: item.workItemId,
      instanceId,
      createdAt: capturedAt,
    });
    if (assignment.decision !== 'accepted') {
      return this.finishExecution(item, assignment, capturedAt, instanceId);
    }
    const delivery = await this.submitOnce({
      requestId: this.requestId(item.workItemId, 'deliver', item.attempt),
      action: 'deliver_work_item',
      mode: this.policy.mode,
      requestedBy: this.requestedBy,
      missionId: item.missionId,
      workItemId: item.workItemId,
      instanceId,
      createdAt: capturedAt,
    });
    return this.finishExecution(item, delivery, capturedAt, instanceId);
  }

  private finishExecution(
    item: CoordinatorPlanItem,
    response: FleetControlResponse,
    capturedAt: number,
    instanceId?: string,
  ): CoordinatorSchedulerExecution {
    if (response.decision === 'accepted') {
      const state = this.stateFor(item.workItemId);
      state.nextAttemptAt = undefined;
      state.pendingInstanceId = undefined;
      return {
        workItemId: item.workItemId,
        attempt: item.attempt,
        action: item.action,
        decision: response.decision,
        response,
        instanceId,
      };
    }
    const retryAt =
      response.decision === 'unavailable'
        ? this.recordFailure(item.workItemId, capturedAt)
        : undefined;
    return {
      workItemId: item.workItemId,
      attempt: item.attempt,
      action: item.action,
      decision: response.decision,
      response,
      instanceId,
      retryAt,
    };
  }

  private async submitRecommendation(
    workItem: WorkItem,
    capturedAt: number,
    candidates: FleetInstance[],
    launchTemplates: FleetLaunchTemplate[],
    attempt: number,
  ): Promise<FleetControlResponse> {
    return this.submitOnce({
      requestId: this.requestId(workItem.workItemId, 'recommend', attempt),
      action: 'recommend_assignment',
      mode: this.policy.mode,
      requestedBy: this.requestedBy,
      missionId: workItem.missionId,
      workItemId: workItem.workItemId,
      strategy: {
        now: capturedAt,
        workItem,
        candidates: candidates.map((instance) => ({ instance })),
        launchTemplates,
        policy: this.policy,
      },
      createdAt: capturedAt,
    });
  }

  private async submitOnce(request: FleetControlRequest): Promise<FleetControlResponse> {
    const previous = this.responses.get(request.requestId);
    if (previous) return clone(previous);
    const response = await this.control.submit(request);
    this.responses.set(request.requestId, clone(response));
    return clone(response);
  }

  private findLaunchTemplate(
    proposed: NonNullable<StrategyRecommendation['proposedLaunchTemplate']>,
  ) {
    return this.launchTemplates.find(
      (template) =>
        template.runtime === proposed.runtime &&
        template.role === proposed.role &&
        template.repo === proposed.repo &&
        (template.worktree ?? '') === (proposed.worktree ?? '') &&
        (template.providerProfileId ?? '') === (proposed.providerProfileId ?? '') &&
        (template.modelId ?? '') === (proposed.modelId ?? ''),
    );
  }

  private stateFor(workItemId: string): AttemptState {
    const existing = this.attempts.get(workItemId);
    if (existing) return existing;
    const created = { attempts: 0 } satisfies AttemptState;
    this.attempts.set(workItemId, created);
    return created;
  }

  private recordFailure(workItemId: string, capturedAt: number): number | undefined {
    const state = this.stateFor(workItemId);
    state.attempts += 1;
    if (state.attempts >= this.retry.maxAttempts) {
      state.nextAttemptAt = undefined;
      return undefined;
    }
    const delay = Math.min(
      this.retry.maxBackoffMs,
      this.retry.initialBackoffMs * 2 ** Math.max(0, state.attempts - 1),
    );
    state.nextAttemptAt = capturedAt + delay;
    return state.nextAttemptAt;
  }

  private instanceIdFor(missionId: string, workItemId: string, attempt: number): string {
    return stableRequestToken(`scheduler-instance-${missionId}-${workItemId}-${attempt}`);
  }

  private requestId(workItemId: string, phase: string, attempt: number): string {
    return stableRequestToken(
      `scheduler-${this.missionId ?? 'mission'}-${workItemId}-${phase}-${attempt}`,
    );
  }
}

function normalizeRetryPolicy(
  policy: CoordinatorSchedulerRetryPolicy | undefined,
): Required<CoordinatorSchedulerRetryPolicy> {
  const maxAttempts = policy?.maxAttempts ?? 3;
  const initialBackoffMs = policy?.initialBackoffMs ?? 1_000;
  const maxBackoffMs = policy?.maxBackoffMs ?? 30_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new Error('maxAttempts must be at least 1.');
  if (!Number.isFinite(initialBackoffMs) || initialBackoffMs < 0)
    throw new Error('initialBackoffMs must be non-negative.');
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < initialBackoffMs)
    throw new Error('maxBackoffMs must be at least initialBackoffMs.');
  return { maxAttempts, initialBackoffMs, maxBackoffMs };
}

function dependencyBlockReason(workItem: WorkItem, workItems: WorkItem[]): string | undefined {
  const byId = new Map(workItems.map((candidate) => [candidate.workItemId, candidate]));
  for (const dependencyId of workItem.dependencies ?? []) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return `Dependency ${dependencyId} is missing.`;
    if (dependency.status !== 'completed')
      return `Dependency ${dependencyId} is ${dependency.status}.`;
  }
  return undefined;
}

function isTerminal(status: WorkItem['status']): boolean {
  return ['completed', 'cancelled', 'blocked'].includes(status);
}

function isInProgress(status: WorkItem['status']): boolean {
  return ['assigned', 'active', 'review'].includes(status);
}

function isLaunchTemplateAllowed(
  template: FleetLaunchTemplate,
  workItem: WorkItem,
  policy: FleetControlPolicy,
): boolean {
  return (
    (!workItem.allowedRuntimeTypes?.length ||
      workItem.allowedRuntimeTypes.includes(template.runtime)) &&
    (!workItem.allowedRoles?.length || workItem.allowedRoles.includes(template.role)) &&
    (!policy.allowedRuntimeTypes?.length ||
      policy.allowedRuntimeTypes.includes(template.runtime)) &&
    (!policy.allowedRoles?.length || policy.allowedRoles.includes(template.role)) &&
    (!policy.allowedRepositories?.length || policy.allowedRepositories.includes(template.repo)) &&
    (!workItem.repo || workItem.repo === template.repo)
  );
}

function positiveTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function stableRequestToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-');
  if (normalized.length <= 120) return normalized;
  let hash = 2166136261;
  for (const character of normalized) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return normalized.slice(0, 96) + '-' + (hash >>> 0).toString(36);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
