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

  it('requires a matching Claude prompt ACK before accepting Stop completion', async () => {
    const mission: Mission = {
      missionId: 'claude-ack-mission',
      title: 'Claude ACK',
      objective: 'Test',
      policyMode: 'approve',
      status: 'active',
      createdAt: 1,
    };
    const workItem: WorkItem = {
      workItemId: 'claude-ack-work',
      missionId: mission.missionId,
      title: 'Task',
      objective: 'Task',
      acceptanceCriteria: ['done'],
      status: 'active',
      assignedInstanceId: 'claude-ack-worker',
      createdAt: 1,
    };
    const instance: FleetInstance = {
      instanceId: 'claude-ack-worker',
      runtime: 'claude-code',
      role: 'worker',
      managedByFleet: true,
      workItemId: workItem.workItemId,
      sessionId: 'claude-session-1',
      status: 'working',
      createdAt: 1,
    };
    const control = new FleetControlService({
      missions: [mission],
      workItems: [workItem],
      instances: [instance],
    });
    const correlator = new WorkItemResultCorrelator(control, () => 200);
    const stop: FleetEvent = {
      eventId: 'stop-before-ack',
      eventType: 'task_finished',
      observedAt: 150,
      source: 'claude-hook',
      runtime: 'claude-code',
      instanceId: instance.instanceId,
      sessionId: 'claude-session-1',
    };

    expect(await correlator.consume(stop)).toBeUndefined();
    expect(await control.getWorkItem(workItem.workItemId)).toMatchObject({ status: 'active' });
    expect(await correlator.acceptPrompt(instance.instanceId, 'wrong-session')).toBe(false);
    expect(await correlator.acceptPrompt(instance.instanceId, 'claude-session-1')).toBe(true);
    expect(await correlator.consume(stop)).toMatchObject({ decision: 'accepted' });
    expect(await control.getWorkItem(workItem.workItemId)).toMatchObject({ status: 'completed' });
  });

  it('does not complete a different WorkItem from a duplicate Claude Stop', async () => {
    const mission: Mission = {
      missionId: 'claude-once-mission',
      title: 'Claude once',
      objective: 'Test',
      policyMode: 'approve',
      status: 'active',
      createdAt: 1,
    };
    const first: WorkItem = {
      workItemId: 'claude-once-work-1',
      missionId: mission.missionId,
      title: 'One',
      objective: 'One',
      acceptanceCriteria: ['done'],
      status: 'active',
      assignedInstanceId: 'claude-once-worker',
      createdAt: 1,
    };
    const instance: FleetInstance = {
      instanceId: 'claude-once-worker',
      runtime: 'claude-code',
      role: 'worker',
      managedByFleet: true,
      workItemId: first.workItemId,
      sessionId: 'claude-session-once',
      status: 'working',
      createdAt: 1,
    };
    const control = new FleetControlService({
      missions: [mission],
      workItems: [first],
      instances: [instance],
    });
    const correlator = new WorkItemResultCorrelator(control, () => 200);
    await correlator.acceptPrompt(instance.instanceId, instance.sessionId!);
    const stop: FleetEvent = {
      eventId: 'duplicate-stop',
      eventType: 'task_finished',
      observedAt: 150,
      source: 'claude-hook',
      runtime: 'claude-code',
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
    };
    const firstResult = await correlator.consume(stop);
    const duplicateResult = await correlator.consume({ ...stop, eventId: 'duplicate-stop-2' });
    expect(firstResult).toMatchObject({ decision: 'accepted' });
    expect(duplicateResult).toEqual(firstResult);
    expect(await control.getWorkItem(first.workItemId)).toMatchObject({ status: 'completed' });
  });
});
