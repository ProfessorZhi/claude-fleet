import { describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeAdapter,
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
});
