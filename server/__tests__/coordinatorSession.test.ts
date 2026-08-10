import { afterEach, describe, expect, it } from 'vitest';

import type { FleetInstance, Mission, WorkItem } from '../../core/src/runtimeContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CoordinatorScheduler } from '../src/coordinatorScheduler.js';
import { CoordinatorSession } from '../src/coordinatorSession.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';

describe('CoordinatorSession', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  it('exposes authenticated explicit plan/tick routes without starting a daemon', async () => {
    const mission: Mission = {
      missionId: 'session-mission',
      title: 'Session',
      objective: 'Test explicit coordinator ticks.',
      policyMode: 'suggest',
      status: 'planned',
      createdAt: 1,
    };
    const instance: FleetInstance = {
      instanceId: 'session-worker',
      runtime: 'claude-code',
      role: 'worker',
      managedByFleet: true,
      repo: 'F:/repo',
      status: 'idle',
      createdAt: 1,
    };
    const item: WorkItem = {
      workItemId: 'session-work',
      missionId: mission.missionId,
      title: 'Session task',
      objective: 'Test plan.',
      acceptanceCriteria: ['plan is ready'],
      status: 'queued',
      createdAt: 1,
    };
    const control = new FleetControlService({
      missions: [mission],
      workItems: [item],
      instances: [instance],
    });
    const session = new CoordinatorSession({
      sessionId: 'coordinator-session-1',
      scheduler: new CoordinatorScheduler({
        control,
        requestedBy: 'codex-primary',
        workItems: [item],
        policy: { mode: 'suggest' },
      }),
    });
    handle = await createHttpServer({
      embedded: true,
      token: 'session-token',
      store: new AgentStateStore(),
      controlApi: control,
      coordinatorSession: session,
    });

    const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/coordinator/plan`);
    expect(unauthorized.status).toBe(401);

    const planUrl = `http://127.0.0.1:${handle.port}/api/coordinator/plan?requestId=session-plan-1`;
    const planResponse = await fetch(planUrl, {
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(planResponse.status).toBe(200);
    const planBody = await planResponse.json();
    expect(planBody).toMatchObject({
      decision: 'accepted',
      coordinator: { sessionId: session.sessionId, operation: 'plan' },
    });
    const repeatedPlan = await fetch(planUrl, {
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(await repeatedPlan.json()).toEqual(planBody);

    const tickResponse = await fetch(`http://127.0.0.1:${handle.port}/api/coordinator/tick`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'session-tick-1' }),
    });
    expect(tickResponse.status).toBe(200);
    const tickBody = await tickResponse.json();
    expect(tickBody).toMatchObject({
      decision: 'accepted',
      coordinator: { sessionId: session.sessionId, operation: 'tick' },
    });
    const repeatedTick = await fetch(`http://127.0.0.1:${handle.port}/api/coordinator/tick`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'session-tick-1' }),
    });
    expect(await repeatedTick.json()).toEqual(tickBody);
    const sessionResponse = await fetch(`http://127.0.0.1:${handle.port}/api/coordinator/session`, {
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(await sessionResponse.json()).toMatchObject({ sessionId: session.sessionId });
  });
});
