import { describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeAdapter,
  RuntimeBootstrapListener,
  RuntimeBootstrapSnapshot,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';

const instance: FleetInstance = {
  instanceId: 'delivery-worker',
  runtime: 'claude-code',
  role: 'worker',
  managedByFleet: true,
  repo: 'F:/repo',
  status: 'idle',
  createdAt: 1,
};

class GatedRuntimeHost implements FleetRuntimeHost {
  readonly hostId = 'gated-runtime-host';
  readonly hostType = 'gated-runtime-host';
  readonly sent: string[] = [];
  private snapshot: RuntimeBootstrapSnapshot = {
    state: 'needs_user_interaction',
    reason: 'startup_interaction',
    observedAt: 1,
  };
  private readonly listeners = new Set<RuntimeBootstrapListener>();

  launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return Promise.resolve({ instanceId: request.instance.instanceId, startedAt: 2 });
  }

  stop(_instanceId: string): Promise<void> {
    this.setState({ state: 'stopped', observedAt: 3 });
    return Promise.resolve();
  }

  focus(_instanceId: string): Promise<void> {
    return Promise.resolve();
  }

  sendTask = async (_instanceId: string, task: { workItemId: string }): Promise<void> => {
    this.sent.push(task.workItemId);
  };

  getBootstrapStatus(): RuntimeBootstrapSnapshot {
    return { ...this.snapshot };
  }

  subscribeBootstrap(listener: RuntimeBootstrapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(snapshot: RuntimeBootstrapSnapshot): void {
    this.snapshot = { ...snapshot };
    for (const listener of this.listeners) listener('delivery-worker', { ...snapshot });
  }
}

const gatedAdapter: RuntimeAdapter = {
  runtime: 'claude-code',
  displayName: 'Gated Claude',
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
  getVersion: async () => 'gated',
  buildLaunchSpec: async () => ({}),
  launch: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
  stop: async () => undefined,
  focus: async () => undefined,
  restart: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
  resume: async (request) => ({ instanceId: request.instance.instanceId, startedAt: 2 }),
  discover: async () => [],
  normalizeEvent: () => undefined,
};

function request(
  action: FleetControlRequest['action'],
  requestId: string,
  overrides: Partial<FleetControlRequest> = {},
): FleetControlRequest {
  return {
    requestId,
    action,
    mode: 'approve',
    requestedBy: 'codex-primary',
    createdAt: 1,
    ...overrides,
  };
}

describe('ControlPlane task delivery', () => {
  it('assigns then delivers only the bounded WorkItem brief', async () => {
    const sent: string[] = [];
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
      launch: async (launchRequest: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> => ({
        instanceId: launchRequest.instance.instanceId,
        startedAt: 2,
      }),
      stop: async () => undefined,
      focus: async () => undefined,
      restart: async (launchRequest) => ({
        instanceId: launchRequest.instance.instanceId,
        startedAt: 2,
      }),
      resume: async (launchRequest) => ({
        instanceId: launchRequest.instance.instanceId,
        startedAt: 2,
      }),
      discover: async () => [],
      normalizeEvent: () => undefined,
    };
    const host: FleetRuntimeHost & { sendTask: NonNullable<FleetRuntimeHost['sendTask']> } = {
      hostId: 'fake-delivery-host',
      hostType: 'fake',
      launch: adapter.launch,
      stop: adapter.stop,
      focus: adapter.focus,
      sendTask: async (_instanceId, task) => {
        sent.push(
          [task.workItemId, task.title, task.objective, ...task.acceptanceCriteria].join('\n'),
        );
      },
    };
    const service = new FleetControlService({
      now: () => 100,
      instances: [instance],
      registrations: [{ adapter, host }],
    });

    await service.submit(
      request('create_mission', 'delivery-mission', {
        mode: 'suggest',
        mission: {
          missionId: 'delivery-mission',
          title: 'Delivery',
          objective: 'Deliver task',
          policyMode: 'approve',
        },
      }),
    );
    await service.submit(
      request('create_work_item', 'delivery-work', {
        mode: 'suggest',
        missionId: 'delivery-mission',
        workItem: {
          workItemId: 'delivery-work',
          missionId: 'delivery-mission',
          title: 'Bounded task',
          objective: 'Run the safe task brief',
          acceptanceCriteria: ['tests pass'],
        },
      }),
    );
    await service.submit(
      request('assign_work_item', 'delivery-assign', {
        missionId: 'delivery-mission',
        workItemId: 'delivery-work',
        instanceId: 'delivery-worker',
      }),
    );
    const delivered = await service.submit(
      request('deliver_work_item', 'delivery-send', {
        missionId: 'delivery-mission',
        workItemId: 'delivery-work',
        instanceId: 'delivery-worker',
      }),
    );

    expect(delivered).toMatchObject({
      decision: 'accepted',
      delivery: { status: 'delivered' },
    });
    expect(sent).toEqual(['delivery-work\nBounded task\nRun the safe task brief\ntests pass']);
    expect(JSON.stringify(delivered)).not.toContain('transcript');
  });

  it('queues before runtime readiness, flushes once, and cancels pending work on stop', async () => {
    const host = new GatedRuntimeHost();
    const service = new FleetControlService({
      now: () => 100,
      instances: [instance, { ...instance, instanceId: 'delivery-worker-2' }],
      registrations: [{ adapter: gatedAdapter, host }],
    });
    const createMission = (requestId: string): FleetControlRequest =>
      request('create_mission', requestId, {
        mode: 'suggest',
        mission: {
          missionId: 'delivery-mission',
          title: 'Delivery',
          objective: 'Deliver task',
          policyMode: 'approve',
        },
      });
    await service.submit(createMission('gated-mission'));
    await service.submit(
      request('create_work_item', 'gated-work-create', {
        mode: 'suggest',
        missionId: 'delivery-mission',
        workItem: {
          workItemId: 'gated-work',
          missionId: 'delivery-mission',
          title: 'Trust-gated task',
          objective: 'Wait for runtime readiness.',
          acceptanceCriteria: ['deliver once'],
        },
      }),
    );
    await service.submit(
      request('assign_work_item', 'gated-assign', {
        missionId: 'delivery-mission',
        workItemId: 'gated-work',
        instanceId: 'delivery-worker',
      }),
    );

    const queued = await service.submit(
      request('deliver_work_item', 'gated-send-1', {
        missionId: 'delivery-mission',
        workItemId: 'gated-work',
        instanceId: 'delivery-worker',
      }),
    );
    const duplicate = await service.submit(
      request('deliver_work_item', 'gated-send-2', {
        missionId: 'delivery-mission',
        workItemId: 'gated-work',
        instanceId: 'delivery-worker',
      }),
    );
    expect(queued).toMatchObject({
      decision: 'accepted',
      delivery: { status: 'queued', lifecycle: 'queued_for_runtime' },
    });
    expect(duplicate.delivery?.lifecycle).toBe('queued_for_runtime');
    expect(host.sent).toEqual([]);

    host.setState({ state: 'ready', observedAt: 101 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.sent).toEqual(['gated-work']);
    expect(service.getDeliveryStatus('gated-work')).toMatchObject({
      status: 'delivered',
      lifecycle: 'delivered_to_runtime',
    });

    const replay = await service.submit(
      request('deliver_work_item', 'gated-send-3', {
        missionId: 'delivery-mission',
        workItemId: 'gated-work',
        instanceId: 'delivery-worker',
      }),
    );
    expect(replay.delivery?.lifecycle).toBe('delivered_to_runtime');
    expect(host.sent).toEqual(['gated-work']);

    await service.submit(
      request('create_work_item', 'gated-cancel-create', {
        mode: 'suggest',
        missionId: 'delivery-mission',
        workItem: {
          workItemId: 'gated-cancel',
          missionId: 'delivery-mission',
          title: 'Cancel me',
          objective: 'Remain pending.',
          acceptanceCriteria: ['must not send'],
        },
      }),
    );
    await service.submit(
      request('assign_work_item', 'gated-cancel-assign', {
        missionId: 'delivery-mission',
        workItemId: 'gated-cancel',
        instanceId: 'delivery-worker-2',
      }),
    );
    host.setState({ state: 'needs_user_interaction', reason: 'workspace_trust', observedAt: 102 });
    await service.submit(
      request('deliver_work_item', 'gated-cancel-send', {
        missionId: 'delivery-mission',
        workItemId: 'gated-cancel',
        instanceId: 'delivery-worker-2',
      }),
    );
    await service.submit(
      request('stop_instance', 'gated-stop', {
        mode: 'approve',
        instanceId: 'delivery-worker-2',
      }),
    );
    expect(service.getDeliveryStatus('gated-cancel')).toMatchObject({
      status: 'cancelled',
      lifecycle: 'cancelled',
    });
    await expect(service.getInstance('delivery-worker-2')).resolves.toMatchObject({
      status: 'stopped',
      bootstrap: { state: 'stopped' },
    });
    expect(host.sent).toEqual(['gated-work']);
  });
});
