import { afterEach, describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type { FleetInstance, WorkItem } from '../../core/src/runtimeContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FleetControlClient } from '../src/fleetControlClient.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';

describe('Fleet Control recommendation workflow', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  it('creates a WorkItem, recommends a synced instance, and records the decision over HTTP', async () => {
    const instance: FleetInstance = {
      instanceId: 'agent-1',
      runtime: 'claude-code',
      role: 'worker',
      managedByFleet: true,
      repo: 'F:/repo',
      status: 'idle',
      createdAt: 1,
    };
    const service = new FleetControlService({ now: () => 100, instances: [instance] });
    handle = await createHttpServer({
      embedded: true,
      token: 'local-test-token',
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: 'local-test-token' });

    const mission = await client.submit({
      requestId: 'e2e-mission',
      action: 'create_mission',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      createdAt: 1,
      mission: {
        missionId: 'mission-e2e',
        title: 'Local recommendation',
        objective: 'Verify the management-plane recommendation path.',
        policyMode: 'suggest',
      },
    });
    expect(mission.decision).toBe('accepted');

    const workItem: WorkItem = {
      workItemId: 'work-e2e',
      missionId: 'mission-e2e',
      title: 'Choose a worker',
      objective: 'Use the existing idle Claude instance.',
      acceptanceCriteria: ['recommendation is recorded'],
      status: 'queued',
      repo: 'F:/repo',
      createdAt: 1,
    };
    const created = await client.submit({
      requestId: 'e2e-work',
      action: 'create_work_item',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: workItem.missionId,
      createdAt: 2,
      workItem,
    });
    expect(created.decision).toBe('accepted');

    const recommendationRequest: FleetControlRequest = {
      requestId: 'e2e-recommendation',
      action: 'recommend_assignment',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: workItem.missionId,
      workItemId: workItem.workItemId,
      createdAt: 3,
      strategy: {
        now: 3,
        workItem,
        policy: { mode: 'suggest' },
      },
    };
    const recommendation = await client.submit(recommendationRequest);

    expect(recommendation).toMatchObject({
      requestId: 'e2e-recommendation',
      decision: 'accepted',
      recommendation: {
        action: 'assign_existing',
        selectedInstanceId: 'agent-1',
      },
    });
    expect(service.ledger.listAssignments('work-e2e')).toHaveLength(1);
    expect(JSON.stringify(recommendation)).not.toContain('local-test-token');
  });
});
