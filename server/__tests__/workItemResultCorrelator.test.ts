import { describe, expect, it } from 'vitest';

import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type { FleetInstance, Mission, WorkItem } from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { WorkItemResultCorrelator } from '../src/workItemResultCorrelator.js';

describe('WorkItemResultCorrelator', () => {
  it('correlates task_finished once and never forwards raw event content', async () => {
    const mission: Mission = {
      missionId: 'result-mission',
      title: 'Results',
      objective: 'Test result correlation.',
      policyMode: 'approve',
      status: 'active',
      createdAt: 1,
    };
    const workItem: WorkItem = {
      workItemId: 'result-work',
      missionId: mission.missionId,
      title: 'Result task',
      objective: 'Complete safely.',
      acceptanceCriteria: ['done'],
      status: 'active',
      assignedInstanceId: 'result-worker',
      createdAt: 1,
    };
    const instance: FleetInstance = {
      instanceId: 'result-worker',
      runtime: 'codex-cli',
      role: 'worker',
      managedByFleet: true,
      workItemId: workItem.workItemId,
      status: 'working',
      createdAt: 1,
    };
    const control = new FleetControlService({
      missions: [mission],
      workItems: [workItem],
      instances: [instance],
      now: () => 200,
    });
    const correlator = new WorkItemResultCorrelator(control, () => 200);
    const event: FleetEvent = {
      eventId: 'event-result-1',
      eventType: 'task_finished',
      observedAt: 150,
      source: 'external',
      instanceId: instance.instanceId,
      error: { message: 'secret=do-not-forward', timestamp: 150, source: 'fixture' },
    };

    const first = await correlator.consume(event);
    const second = await correlator.consume(event);
    expect(first).toMatchObject({ decision: 'accepted', result: { outcome: 'completed' } });
    expect(second).toEqual(first);
    expect(await control.getWorkItem(workItem.workItemId)).toMatchObject({
      status: 'completed',
      result: { source: 'runtime', summary: 'Runtime reported task completion.' },
    });
    expect(JSON.stringify(first)).not.toContain('secret=do-not-forward');
  });
});
