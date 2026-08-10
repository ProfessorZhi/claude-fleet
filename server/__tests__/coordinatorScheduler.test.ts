import { describe, expect, it } from 'vitest';

import type {
  FleetControlApi,
  FleetControlRequest,
  FleetControlResponse,
  FleetLaunchTemplate,
} from '../../core/src/controlContracts.js';
import type { FleetMetricsSnapshot } from '../../core/src/controlContracts.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  Mission,
  RuntimeAdapter,
  WorkItem,
} from '../../core/src/runtimeContracts.js';
import { CoordinatorScheduler } from '../src/coordinatorScheduler.js';
import { FleetControlService } from '../src/fleetControlService.js';

const mission: Mission = {
  missionId: 'mission-scheduler',
  title: 'Scheduler',
  objective: 'Exercise the local Coordinator loop.',
  policyMode: 'approve',
  status: 'planned',
  createdAt: 1,
};

const claudeWorker: FleetInstance = {
  instanceId: 'claude-worker',
  runtime: 'claude-code',
  role: 'worker',
  managedByFleet: true,
  repo: 'F:/repo',
  status: 'idle',
  createdAt: 1,
};

const codexReviewer: FleetInstance = {
  instanceId: 'codex-reviewer',
  runtime: 'codex-cli',
  role: 'reviewer',
  managedByFleet: true,
  repo: 'F:/repo',
  status: 'idle',
  createdAt: 1,
};

function workItem(workItemId: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId,
    missionId: mission.missionId,
    title: workItemId,
    objective: `Implement ${workItemId}.`,
    acceptanceCriteria: ['tests pass'],
    status: 'queued',
    createdAt: 1,
    ...overrides,
  };
}

function serviceWith(
  items: WorkItem[],
  instances: FleetInstance[] = [claudeWorker],
): FleetControlService {
  const adapter: RuntimeAdapter = {
    runtime: 'claude-code',
    displayName: 'Fake Claude',
    capabilities: {
      launch: true,
      stop: true,
      focus: true,
      restart: true,
      resume: true,
      discover: true,
      structuredEvents: true,
      nativeSessionContinuity: true,
    },
    detect: async () => true,
    getVersion: async () => 'fake',
    buildLaunchSpec: async () => ({}),
    launch: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
    stop: async () => undefined,
    focus: async () => undefined,
    restart: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
    resume: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
    discover: async () => [],
    normalizeEvent: () => undefined,
  };
  const host: FleetRuntimeHost = {
    hostId: 'scheduler-test-host',
    hostType: 'fake',
    launch: adapter.launch,
    stop: adapter.stop,
    focus: adapter.focus,
    sendTask: async () => undefined,
  };
  return new FleetControlService({
    missions: [mission],
    workItems: items,
    instances,
    registrations: [{ adapter, host }],
    now: () => 100,
  });
}

function scheduler(
  control: FleetControlApi,
  items: WorkItem[],
  overrides: Partial<ConstructorParameters<typeof CoordinatorScheduler>[0]> = {},
): CoordinatorScheduler {
  return new CoordinatorScheduler({
    control,
    requestedBy: 'codex-primary',
    workItems: items,
    ...overrides,
  });
}

describe('CoordinatorScheduler', () => {
  it('plans by default and does not assign or launch in suggest mode', async () => {
    const item = workItem('work-plan-only');
    const service = serviceWith([item]);
    const control = service as FleetControlApi;
    const loop = scheduler(control, [item]);

    const plan = await loop.plan();
    expect(plan.items[0]).toMatchObject({
      workItemId: item.workItemId,
      missionId: mission.missionId,
      status: 'ready',
      action: 'assign_existing',
      selectedInstanceId: claudeWorker.instanceId,
    });
    expect((await service.getWorkItem(item.workItemId))?.status).toBe('queued');

    const tick = await loop.tick();
    expect(tick.sideEffectsExecuted).toBe(false);
    expect(tick.executions).toHaveLength(0);
    expect((await service.getWorkItem(item.workItemId))?.status).toBe('queued');
  });

  it('respects dependencies, max concurrency, and runtime/role constraints', async () => {
    const dependencyA = workItem('work-a');
    const dependencyB = workItem('work-b', { dependencies: ['work-a'] });
    const dependencyService = serviceWith([dependencyA, dependencyB]);
    const dependencyPlan = await scheduler(dependencyService, [dependencyA, dependencyB]).plan();
    expect(dependencyPlan.items.map((item) => item.status)).toEqual([
      'ready',
      'dependency_blocked',
    ]);

    const running: FleetInstance = {
      ...claudeWorker,
      instanceId: 'running-worker',
      status: 'working',
    };
    const constrained = workItem('work-constrained', {
      allowedRuntimeTypes: ['codex-cli'],
      allowedRoles: ['reviewer'],
    });
    const constrainedService = serviceWith([constrained], [claudeWorker, codexReviewer]);
    const constrainedPlan = await scheduler(constrainedService, [constrained]).plan();
    expect(constrainedPlan.items[0]).toMatchObject({
      status: 'ready',
      action: 'assign_existing',
      selectedInstanceId: codexReviewer.instanceId,
    });

    const capped = workItem('work-capped');
    const cappedService = serviceWith([capped], [running]);
    const cappedPlan = await scheduler(cappedService, [capped], {
      policy: { mode: 'approve', maxConcurrentInstances: 1 },
      launchTemplates: [launchTemplate()],
    }).plan();
    expect(cappedPlan.items[0]).toMatchObject({
      status: 'concurrency_blocked',
    });
  });

  it('executes recommend then assign for approve policy and remains idempotent', async () => {
    const item = workItem('work-assign');
    const service = serviceWith([item]);
    const loop = scheduler(service, [item], { policy: { mode: 'approve' } });

    const first = await loop.tick();
    expect(first.sideEffectsExecuted).toBe(true);
    expect(first.executions[0]).toMatchObject({
      action: 'assign_existing',
      decision: 'accepted',
      instanceId: claudeWorker.instanceId,
    });
    expect((await service.getWorkItem(item.workItemId))?.assignedInstanceId).toBe(
      claudeWorker.instanceId,
    );

    const decisionCount = service.ledger.listAssignments(item.workItemId).length;
    const second = await loop.tick();
    expect(second.executions[0]).toMatchObject({ decision: 'accepted' });
    expect(service.ledger.listAssignments(item.workItemId)).toHaveLength(decisionCount);
  });

  it('executes recommend, launch, then assign with a deterministic instance id', async () => {
    const item = workItem('work-launch', {
      allowedRuntimeTypes: ['codex-cli'],
      allowedRoles: ['worker'],
    });
    const requests: FleetControlRequest[] = [];
    const instance: FleetInstance = {
      instanceId: 'placeholder',
      runtime: 'codex-cli',
      role: 'worker',
      managedByFleet: true,
      repo: 'F:/repo',
      status: 'starting',
      createdAt: 100,
    };
    let launched: FleetInstance | undefined;
    const control = fakeControl(
      requests,
      (request) => {
        if (request.action === 'recommend_assignment') {
          return acceptedRecommendation(request, launchTemplate());
        }
        if (request.action === 'launch_instance') {
          launched = {
            ...instance,
            instanceId: request.instanceId!,
            workItemId: request.workItemId,
          };
          return { requestId: request.requestId, decision: 'accepted', instance: launched };
        }
        if (request.action === 'assign_work_item') {
          return {
            requestId: request.requestId,
            decision: 'accepted',
            instance: launched,
            workItem: { ...item, status: 'active', assignedInstanceId: request.instanceId },
          };
        }
        if (request.action === 'deliver_work_item') {
          return { requestId: request.requestId, decision: 'accepted' };
        }
        throw new Error('Unexpected request: ' + request.action);
      },
      () => (launched ? [launched] : []),
    );
    const loop = scheduler(control, [item], {
      policy: { mode: 'approve', maxConcurrentInstances: 1 },
      launchTemplates: [launchTemplate()],
    });

    const result = await loop.tick();
    expect(result.executions[0]).toMatchObject({ action: 'launch_new', decision: 'accepted' });
    expect(requests.map((request) => request.action)).toEqual([
      'recommend_assignment',
      'launch_instance',
      'assign_work_item',
      'deliver_work_item',
    ]);
    expect(requests[1].instanceId).toBe(requests[2].instanceId);
    expect(requests[1].workItemId).toBe(item.workItemId);
  });

  it('uses bounded retry with backoff and does not repeat during the wait window', async () => {
    const item = workItem('work-retry');
    const requests: FleetControlRequest[] = [];
    let now = 100;
    let assignmentAttempts = 0;
    const control = fakeControl(requests, (request) => {
      if (request.action === 'recommend_assignment') return acceptedRecommendation(request);
      if (request.action === 'assign_work_item') {
        assignmentAttempts += 1;
        if (assignmentAttempts === 1) {
          return {
            requestId: request.requestId,
            decision: 'unavailable',
            reason: 'temporary host failure',
          };
        }
        return { requestId: request.requestId, decision: 'accepted' };
      }
      if (request.action === 'deliver_work_item') {
        return { requestId: request.requestId, decision: 'accepted' };
      }
      throw new Error('Unexpected request: ' + request.action);
    });
    const loop = scheduler(control, [item], {
      policy: { mode: 'approve' },
      now: () => now,
      retry: { maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 10 },
    });

    const first = await loop.tick();
    expect(first.executions[0]).toMatchObject({ decision: 'unavailable', retryAt: 110 });
    expect(requests.map((request) => request.action)).toEqual([
      'recommend_assignment',
      'assign_work_item',
    ]);

    now = 105;
    const waiting = await loop.tick();
    expect(waiting.executions).toHaveLength(0);
    expect(requests).toHaveLength(2);

    now = 110;
    const retried = await loop.tick();
    expect(retried.executions[0]).toMatchObject({ decision: 'accepted', attempt: 2 });
    expect(requests.map((request) => request.action)).toEqual([
      'recommend_assignment',
      'assign_work_item',
      'recommend_assignment',
      'assign_work_item',
      'deliver_work_item',
    ]);
  });

  it('retries task delivery after assignment without selecting a new instance', async () => {
    const item = workItem('work-delivery-retry');
    const requests: FleetControlRequest[] = [];
    let now = 100;
    let deliveryAttempts = 0;
    const control = fakeControl(requests, (request) => {
      if (request.action === 'recommend_assignment') return acceptedRecommendation(request);
      if (request.action === 'assign_work_item') {
        return { requestId: request.requestId, decision: 'accepted' };
      }
      if (request.action === 'deliver_work_item') {
        deliveryAttempts += 1;
        return deliveryAttempts === 1
          ? {
              requestId: request.requestId,
              decision: 'unavailable',
              reason: 'temporary task-delivery host failure',
            }
          : { requestId: request.requestId, decision: 'accepted' };
      }
      throw new Error('Unexpected request: ' + request.action);
    });
    const loop = scheduler(control, [item], {
      policy: { mode: 'approve' },
      now: () => now,
      retry: { maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 10 },
    });

    const first = await loop.tick();
    expect(first.executions[0]).toMatchObject({ decision: 'unavailable', retryAt: 110 });
    expect(requests.map((request) => request.action)).toEqual([
      'recommend_assignment',
      'assign_work_item',
      'deliver_work_item',
    ]);

    now = 110;
    const retried = await loop.tick();
    expect(retried.executions[0]).toMatchObject({ decision: 'accepted', attempt: 2 });
    expect(requests.map((request) => request.action)).toEqual([
      'recommend_assignment',
      'assign_work_item',
      'deliver_work_item',
      'assign_work_item',
      'deliver_work_item',
    ]);
  });
});

function launchTemplate(): FleetLaunchTemplate {
  return {
    runtime: 'codex-cli',
    role: 'worker',
    repo: 'F:/repo',
    cwd: 'F:/repo',
    requestedBy: 'codex-primary',
    policy: { mode: 'approve' },
  };
}

function acceptedRecommendation(
  request: FleetControlRequest,
  template?: FleetLaunchTemplate,
): FleetControlResponse {
  const recommendation = {
    recommendationId: 'recommendation-' + request.workItemId + '-' + request.requestId,
    strategyVersion: 'test-strategy',
    missionId: request.missionId!,
    workItemId: request.workItemId!,
    action: template ? ('launch_new' as const) : ('assign_existing' as const),
    selectedInstanceId: template ? undefined : 'claude-worker',
    candidateInstanceIds: template ? [] : ['claude-worker'],
    alternatives: [],
    proposedLaunchTemplate: template,
    factors: [],
    constraints: [],
    confidence: 'medium' as const,
    expiresAt: request.createdAt + 1000,
  };
  return { requestId: request.requestId, decision: 'accepted', recommendation };
}

function fakeControl(
  requests: FleetControlRequest[],
  submit: (request: FleetControlRequest) => FleetControlResponse,
  listInstances: () => FleetInstance[] = () => [claudeWorker],
): FleetControlApi {
  const metrics: FleetMetricsSnapshot = {
    capturedAt: 100,
    usage: [],
    sessions: [],
    quotas: [],
    totals: { durationMs: 0, tokens: {} },
  };
  return {
    async submit(request) {
      requests.push(request);
      return submit(request);
    },
    listInstances,
    async getInstance(instanceId) {
      return listInstances().find((instance) => instance.instanceId === instanceId);
    },
    getMetrics: () => metrics,
    async getMission() {
      return mission;
    },
    async getWorkItem(workItemId) {
      return workItem(workItemId);
    },
  };
}
