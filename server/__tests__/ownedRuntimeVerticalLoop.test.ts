import { describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type {
  FleetRuntimeHost,
  RuntimeAdapter,
  RuntimeBootstrapListener,
  RuntimeBootstrapSnapshot,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
} from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { WorkItemResultCorrelator } from '../src/workItemResultCorrelator.js';

class OwnedHostFixture implements FleetRuntimeHost {
  readonly hostId = 'owned-host-fixture';
  readonly hostType = 'owned-host-fixture';
  readonly launches: RuntimeLaunchRequest[] = [];
  readonly sent: RuntimeTaskBrief[] = [];
  readonly focused: string[] = [];
  readonly stopped: string[] = [];

  private readonly snapshots = new Map<string, RuntimeBootstrapSnapshot>();
  private readonly listeners = new Set<RuntimeBootstrapListener>();

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.launches.push(request);
    this.snapshots.set(request.instance.instanceId, {
      state: 'starting',
      reason: 'startup_interaction',
      observedAt: 1,
    });
    return {
      instanceId: request.instance.instanceId,
      transport: 'owned',
      sessionId: request.sessionId ?? 'owned-session-1',
      terminalId: `terminal-${request.instance.instanceId}`,
      terminalName: request.instance.displayName,
      hostId: this.hostId,
      workspaceId: request.cwd,
      resolvedProviderProfileId: request.providerProfileId,
      resolvedModelId: request.modelId,
      startedAt: 2,
    };
  }

  async stop(instanceId: string): Promise<void> {
    this.stopped.push(instanceId);
    this.setReadyState(instanceId, { state: 'stopped', observedAt: 10 });
  }

  async focus(instanceId: string): Promise<void> {
    this.focused.push(instanceId);
  }

  async sendTask(_instanceId: string, task: RuntimeTaskBrief): Promise<void> {
    this.sent.push({ ...task, acceptanceCriteria: [...task.acceptanceCriteria] });
  }

  getBootstrapStatus(instanceId: string): RuntimeBootstrapSnapshot | undefined {
    return this.snapshots.get(instanceId);
  }

  subscribeBootstrap(listener: RuntimeBootstrapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setReadyState(instanceId: string, snapshot: RuntimeBootstrapSnapshot): void {
    this.snapshots.set(instanceId, snapshot);
    for (const listener of this.listeners) listener(instanceId, { ...snapshot });
  }
}

function ownedAdapter(): RuntimeAdapter {
  return {
    runtime: 'claude-code',
    displayName: 'Claude Code · Owned',
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
    getVersion: async () => 'fixture',
    buildLaunchSpec: async () => ({ transport: 'owned' }),
    launch: async (request) => ({
      instanceId: request.instance.instanceId,
      transport: 'owned',
      sessionId: request.sessionId,
      startedAt: 2,
    }),
    stop: async () => undefined,
    focus: async () => undefined,
    restart: async (request) => ({
      instanceId: request.instance.instanceId,
      transport: 'owned',
      sessionId: request.sessionId,
      startedAt: 2,
    }),
    resume: async (request) => ({
      instanceId: request.instance.instanceId,
      transport: 'owned',
      sessionId: request.sessionId,
      startedAt: 2,
    }),
    discover: async () => [],
    normalizeEvent: () => undefined,
  };
}

function request(
  action: FleetControlRequest['action'],
  requestId: string,
  overrides: Partial<FleetControlRequest> = {},
): FleetControlRequest {
  return {
    requestId,
    action,
    mode: action === 'launch_instance' || action === 'deliver_work_item' ? 'approve' : 'suggest',
    requestedBy: 'codex-coordinator',
    createdAt: 1,
    ...overrides,
  } as FleetControlRequest;
}

function runtimeEvent(
  instanceId: string,
  sessionId: string,
  eventType: FleetEvent['eventType'],
  workItemId: string,
  resultSummary?: string,
): FleetEvent {
  return {
    eventId: `${workItemId}-${eventType}`,
    eventType,
    observedAt: 20,
    source: 'claude-jsonl',
    instanceId,
    runtime: 'claude-code',
    managedByFleet: true,
    sessionId,
    workItemId,
    ...(resultSummary ? { resultSummary } : {}),
  };
}

describe('Claude owned runtime vertical loop', () => {
  it('queues before ready, delivers once, correlates result, and reuses one session', async () => {
    const host = new OwnedHostFixture();
    const service = new FleetControlService({
      now: () => 20,
      registrations: [{ adapter: ownedAdapter(), host, transport: 'owned' }],
    });
    const correlator = new WorkItemResultCorrelator(service, () => 20);

    await service.submit(
      request('create_mission', 'owned-mission-create', {
        mission: {
          missionId: 'owned-mission',
          title: 'Owned loop',
          objective: 'Exercise the owned runtime boundary.',
          policyMode: 'approve',
        },
      }),
    );
    for (const [id, title, objective] of [
      ['owned-work-1', 'First turn', 'Respond with exactly: FLEET_READY'],
      ['owned-work-2', 'Second turn', 'Respond with exactly: SECOND_TURN_OK'],
    ] as const) {
      const created = await service.submit(
        request('create_work_item', `${id}-create`, {
          missionId: 'owned-mission',
          workItem: {
            workItemId: id,
            missionId: 'owned-mission',
            title,
            objective,
            acceptanceCriteria: ['return the exact marker'],
          },
        }),
      );
      expect(created.decision).toBe('accepted');
    }

    const launch = await service.submit(
      request('launch_instance', 'owned-launch', {
        mode: 'approve',
        instanceId: 'claude-owned-full-loop-1',
        missionId: 'owned-mission',
        workItemId: 'owned-work-1',
        launch: {
          runtime: 'claude-code',
          transport: 'owned',
          role: 'worker',
          displayName: 'astrid',
          repo: 'F:/agent_test/agent-fleet-claude-integration-workspace',
          cwd: 'F:/agent_test/agent-fleet-claude-integration-workspace',
          providerProfileId: 'deepseek.msk2hxew',
          modelId: 'deepseek-v4-flash',
          requestedBy: 'codex-coordinator',
          policy: { mode: 'approve' },
        },
      }),
    );
    expect(launch).toMatchObject({
      decision: 'accepted',
      instance: { displayName: 'astrid', transport: 'owned', sessionId: 'owned-session-1' },
    });
    const instanceId = 'claude-owned-full-loop-1';
    const sessionId = 'owned-session-1';

    const assignment1 = await service.submit(
      request('assign_work_item', 'owned-work-1-assign', {
        mode: 'approve',
        missionId: 'owned-mission',
        workItemId: 'owned-work-1',
        instanceId,
      }),
    );
    expect(assignment1.decision).toBe('accepted');

    const queued = await service.submit(
      request('deliver_work_item', 'owned-work-1-deliver', {
        mode: 'approve',
        missionId: 'owned-mission',
        workItemId: 'owned-work-1',
        instanceId,
      }),
    );
    expect(queued.delivery).toMatchObject({ lifecycle: 'queued_for_runtime' });
    expect(host.sent).toHaveLength(0);

    host.setReadyState(instanceId, {
      state: 'ready',
      readinessSource: 'native_session',
      confidence: 'exact',
      observedAt: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.sent).toHaveLength(1);
    expect(service.getDeliveryStatus('owned-work-1', instanceId)).toMatchObject({
      lifecycle: 'delivered_to_runtime',
    });

    const promptAck = await correlator.consume(
      runtimeEvent(instanceId, sessionId, 'prompt_accepted', 'owned-work-1'),
    );
    expect(promptAck).toBeUndefined();
    const firstResult = await correlator.consume(
      runtimeEvent(instanceId, sessionId, 'task_finished', 'owned-work-1', 'FLEET_READY'),
    );
    const duplicateFirstResult = await correlator.consume(
      runtimeEvent(instanceId, sessionId, 'task_finished', 'owned-work-1', 'FLEET_READY'),
    );
    expect(firstResult).toMatchObject({ decision: 'accepted', result: { summary: 'FLEET_READY' } });
    expect(duplicateFirstResult).toEqual(firstResult);
    expect(await service.getInstance(instanceId)).toMatchObject({ status: 'idle' });
    expect(await service.getWorkItem('owned-work-1')).toMatchObject({
      status: 'completed',
      result: { summary: 'FLEET_READY' },
    });

    const assignment2 = await service.submit(
      request('assign_work_item', 'owned-work-2-assign', {
        mode: 'approve',
        missionId: 'owned-mission',
        workItemId: 'owned-work-2',
        instanceId,
      }),
    );
    expect(assignment2.decision).toBe('accepted');
    const secondDelivery = await service.submit(
      request('deliver_work_item', 'owned-work-2-deliver', {
        mode: 'approve',
        missionId: 'owned-mission',
        workItemId: 'owned-work-2',
        instanceId,
      }),
    );
    expect(secondDelivery.delivery).toMatchObject({ lifecycle: 'delivered_to_runtime' });
    expect(host.sent).toHaveLength(2);

    await correlator.consume(
      runtimeEvent(instanceId, sessionId, 'prompt_accepted', 'owned-work-2'),
    );
    const secondResult = await correlator.consume(
      runtimeEvent(instanceId, sessionId, 'task_finished', 'owned-work-2', 'SECOND_TURN_OK'),
    );
    expect(secondResult).toMatchObject({
      decision: 'accepted',
      result: { summary: 'SECOND_TURN_OK' },
    });
    expect(host.launches).toHaveLength(1);
    expect(host.sent.map((task) => task.objective)).toEqual([
      'Respond with exactly: FLEET_READY',
      'Respond with exactly: SECOND_TURN_OK',
    ]);

    await service.submit(
      request('focus_instance', 'owned-focus', {
        mode: 'approve',
        instanceId,
      }),
    );
    await service.submit(
      request('stop_instance', 'owned-stop', {
        mode: 'approve',
        instanceId,
      }),
    );
    expect(host.focused).toEqual([instanceId]);
    expect(host.stopped).toEqual([instanceId]);
  });
});
