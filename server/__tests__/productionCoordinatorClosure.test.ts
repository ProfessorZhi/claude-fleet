import { afterEach, describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  Mission,
  RuntimeAdapter,
  WorkItem,
} from '../../core/src/runtimeContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CoordinatorScheduler } from '../src/coordinatorScheduler.js';
import { CoordinatorSession } from '../src/coordinatorSession.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';

const mission: Mission = {
  missionId: 'closure-mission',
  title: 'Closure',
  objective: 'Exercise the bounded Coordinator loop.',
  policyMode: 'approve',
  status: 'planned',
  createdAt: 1,
};

const instance: FleetInstance = {
  instanceId: 'closure-worker',
  runtime: 'claude-code',
  role: 'worker',
  managedByFleet: true,
  repo: 'F:/repo',
  status: 'idle',
  createdAt: 1,
};

function item(): WorkItem {
  return {
    workItemId: 'closure-work',
    missionId: mission.missionId,
    title: 'Bounded task',
    objective: 'Exercise result correlation.',
    acceptanceCriteria: ['result is correlated'],
    status: 'queued',
    createdAt: 1,
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
    mode: 'approve',
    requestedBy: 'codex-primary',
    createdAt: 100,
    ...overrides,
  };
}

function fakeRuntime(onTask: (task: unknown) => void): {
  adapter: RuntimeAdapter;
  host: FleetRuntimeHost;
} {
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
    launch: async (input) => ({ instanceId: input.instance.instanceId, startedAt: 100 }),
    stop: async () => undefined,
    focus: async () => undefined,
    restart: async (input) => ({ instanceId: input.instance.instanceId, startedAt: 100 }),
    resume: async (input) => ({ instanceId: input.instance.instanceId, startedAt: 100 }),
    discover: async () => [],
    normalizeEvent: () => undefined,
  };
  return {
    adapter,
    host: {
      hostId: 'closure-host',
      hostType: 'fake',
      launch: adapter.launch,
      stop: adapter.stop,
      focus: adapter.focus,
      sendTask: async (_instanceId, task) => onTask(task),
    },
  };
}

describe('Production closure Coordinator and result boundaries', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  it('runs an approved session tick, stays idempotent, and keeps suggest read-only', async () => {
    const delivered: unknown[] = [];
    const runtime = fakeRuntime((task) => delivered.push(task));
    const control = new FleetControlService({
      missions: [mission],
      workItems: [item()],
      instances: [instance],
      registrations: [{ adapter: runtime.adapter, host: runtime.host }],
      now: () => 100,
    });
    const scheduler = new CoordinatorScheduler({
      control,
      requestedBy: 'codex-primary',
      workItems: [item()],
      policy: { mode: 'approve' },
    });
    const session = new CoordinatorSession({ sessionId: 'closure-session', scheduler });
    control.registerCoordinatorSession(session);

    const tick = request('coordinator_tick', 'closure-tick', {
      coordinatorSession: { sessionId: session.sessionId, operation: 'tick' },
    });
    const first = await control.submit(tick);
    const second = await control.submit(tick);
    expect(first).toMatchObject({ decision: 'accepted', coordinator: { operation: 'tick' } });
    expect(second).toEqual(first);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      workItemId: 'closure-work',
      title: 'Bounded task',
      objective: 'Exercise result correlation.',
      acceptanceCriteria: ['result is correlated'],
    });

    const suggestControl = new FleetControlService({
      missions: [mission],
      workItems: [item()],
      instances: [instance],
      now: () => 100,
    });
    const suggestSession = new CoordinatorSession({
      sessionId: 'suggest-session',
      scheduler: new CoordinatorScheduler({
        control: suggestControl,
        requestedBy: 'codex-primary',
        workItems: [item()],
        policy: { mode: 'suggest' },
      }),
    });
    suggestControl.registerCoordinatorSession(suggestSession);
    const suggested = await suggestControl.submit(
      request('coordinator_tick', 'suggest-tick', {
        mode: 'suggest',
        coordinatorSession: { sessionId: suggestSession.sessionId, operation: 'tick' },
      }),
    );
    expect(suggested).toMatchObject({
      decision: 'accepted',
      coordinator: { tick: { sideEffectsExecuted: false } },
    });

    const wrongOwner = await control.submit(
      request('coordinator_plan', 'wrong-owner', {
        mode: 'approve',
        requestedBy: 'other-coordinator',
        coordinatorSession: { sessionId: session.sessionId, operation: 'plan' },
      }),
    );
    expect(wrongOwner).toMatchObject({ decision: 'rejected' });
  });

  it('correlates a result from instanceId and rejects unsafe or conflicting envelopes', async () => {
    const control = new FleetControlService({
      missions: [mission],
      workItems: [item()],
      instances: [instance],
      now: () => 100,
    });
    await control.submit(
      request('assign_work_item', 'result-assign', {
        missionId: mission.missionId,
        workItemId: 'closure-work',
        instanceId: instance.instanceId,
      }),
    );

    const correlated = await control.submit(
      request('collect_result', 'result-auto', {
        workItemId: undefined,
        result: {
          instanceId: instance.instanceId,
          outcome: 'completed',
          summary: 'Completed without transcript.',
          artifactRefs: ['test:closure'],
          source: 'runtime',
          availability: 'available',
          confidence: 'high',
        },
      }),
    );
    expect(correlated).toMatchObject({
      decision: 'accepted',
      result: { workItemId: 'closure-work', instanceId: instance.instanceId },
    });

    const duplicate = await control.submit(
      request('collect_result', 'result-auto-duplicate', {
        result: {
          instanceId: instance.instanceId,
          outcome: 'completed',
          summary: 'Completed without transcript.',
          artifactRefs: ['test:closure'],
          source: 'runtime',
          availability: 'available',
          confidence: 'high',
        },
      }),
    );
    expect(duplicate).toMatchObject({ decision: 'accepted', result: correlated.result });

    const conflicting = await control.submit(
      request('collect_result', 'result-conflict', {
        result: {
          instanceId: instance.instanceId,
          outcome: 'failed',
          summary: 'Different result.',
        },
      }),
    );
    expect(conflicting).toMatchObject({ decision: 'rejected' });

    const unsafe = await control.submit(
      request('collect_result', 'result-secret', {
        result: {
          instanceId: instance.instanceId,
          outcome: 'completed',
          summary: 'safe summary',
          transcript: 'must be rejected',
          secret: 'must be rejected',
        } as unknown as FleetControlRequest['result'],
      }),
    );
    expect(unsafe).toMatchObject({ decision: 'rejected' });
    expect(JSON.stringify(unsafe)).not.toContain('must be rejected');
  });

  it('rejects unsafe result fields before HTTP sanitization can silently drop them', async () => {
    const control = new FleetControlService({ now: () => 100 });
    handle = await createHttpServer({
      embedded: true,
      token: 'closure-http-token',
      store: new AgentStateStore(),
      controlApi: control,
    });
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/control`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer closure-http-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        request('collect_result', 'http-result-secret', {
          result: {
            instanceId: instance.instanceId,
            outcome: 'completed',
            transcript: 'never cross the boundary',
          } as never,
        }),
      ),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bounded_result_rejected' });
  });
});
