import { describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';

const instance: FleetInstance = {
  instanceId: 'worker-1',
  runtime: 'claude-code',
  role: 'worker',
  managedByFleet: true,
  repo: 'F:/repo',
  status: 'idle',
  createdAt: 1,
};

function base(action: FleetControlRequest['action'], requestId: string): FleetControlRequest {
  return {
    requestId,
    action,
    mode: 'suggest',
    requestedBy: 'codex-primary',
    createdAt: 1,
  };
}

describe('Coordinator WorkItem workflow', () => {
  it('assigns a WorkItem, activates the mission, and collects a bounded result', async () => {
    const service = new FleetControlService({ now: () => 100, instances: [instance] });

    expect(
      await service.submit({
        ...base('create_mission', 'workflow-mission'),
        mission: {
          missionId: 'mission-workflow',
          title: 'Workflow',
          objective: 'Coordinate one worker',
          policyMode: 'approve',
        },
      }),
    ).toMatchObject({ decision: 'accepted' });

    expect(
      await service.submit({
        ...base('create_work_item', 'workflow-work'),
        missionId: 'mission-workflow',
        workItem: {
          workItemId: 'work-workflow',
          missionId: 'mission-workflow',
          title: 'Implement slice',
          objective: 'Implement the bounded workflow',
          acceptanceCriteria: ['tests pass'],
        },
      }),
    ).toMatchObject({ decision: 'accepted' });

    const assigned = await service.submit({
      ...base('assign_work_item', 'workflow-assign'),
      mode: 'approve',
      missionId: 'mission-workflow',
      workItemId: 'work-workflow',
      instanceId: 'worker-1',
    });
    expect(assigned).toMatchObject({
      decision: 'accepted',
      workItem: { status: 'active', assignedInstanceId: 'worker-1' },
      instance: { workItemId: 'work-workflow', status: 'working' },
    });

    const result = await service.submit({
      ...base('collect_result', 'workflow-result'),
      workItemId: 'work-workflow',
      result: {
        workItemId: 'work-workflow',
        outcome: 'completed',
        summary: 'Implemented and verified.',
        artifactRefs: ['commit:abc123'],
        source: 'runtime',
        confidence: 'high',
      },
    });
    expect(result).toMatchObject({
      decision: 'accepted',
      result: { outcome: 'completed', instanceId: 'worker-1' },
      workItem: { status: 'completed' },
      instance: { status: 'idle' },
    });
    expect(service.ledger.getWorkItem('work-workflow')).toMatchObject({
      status: 'completed',
      result: { summary: 'Implemented and verified.' },
    });
    expect((await service.getMission('mission-workflow'))?.status).toBe('active');
  });

  it('requires approval and rejects incomplete dependencies', async () => {
    const service = new FleetControlService({ now: () => 100, instances: [instance] });
    await service.submit({
      ...base('create_mission', 'dependency-mission'),
      mission: {
        missionId: 'mission-dependency',
        title: 'Dependency',
        objective: 'Check ordering',
        policyMode: 'suggest',
      },
    });
    await service.submit({
      ...base('create_work_item', 'dependency-a'),
      missionId: 'mission-dependency',
      workItem: {
        workItemId: 'work-a',
        missionId: 'mission-dependency',
        title: 'A',
        objective: 'A',
        acceptanceCriteria: ['done'],
      },
    });
    await service.submit({
      ...base('create_work_item', 'dependency-b'),
      missionId: 'mission-dependency',
      workItem: {
        workItemId: 'work-b',
        missionId: 'mission-dependency',
        title: 'B',
        objective: 'B',
        acceptanceCriteria: ['done'],
        dependencies: ['work-a'],
      },
    });

    const approval = await service.submit({
      ...base('assign_work_item', 'dependency-suggest'),
      missionId: 'mission-dependency',
      workItemId: 'work-a',
      instanceId: 'worker-1',
    });
    expect(approval.decision).toBe('approval_required');

    const blocked = await service.submit({
      ...base('assign_work_item', 'dependency-assign'),
      mode: 'approve',
      missionId: 'mission-dependency',
      workItemId: 'work-b',
      instanceId: 'worker-1',
    });
    expect(blocked).toMatchObject({ decision: 'rejected' });
    expect(blocked.reason).toContain('work-a');
  });

  it('does not persist unknown transcript-shaped result fields', async () => {
    const service = new FleetControlService({ now: () => 100, instances: [instance] });
    await service.submit({
      ...base('create_mission', 'safe-mission'),
      mission: {
        missionId: 'mission-safe',
        title: 'Safe',
        objective: 'Safe result',
        policyMode: 'suggest',
      },
    });
    await service.submit({
      ...base('create_work_item', 'safe-work'),
      missionId: 'mission-safe',
      workItem: {
        workItemId: 'work-safe',
        missionId: 'mission-safe',
        title: 'Safe',
        objective: 'Safe result',
        acceptanceCriteria: ['done'],
      },
    });
    const result = await service.submit({
      ...base('collect_result', 'safe-result'),
      workItemId: 'work-safe',
      result: {
        workItemId: 'work-safe',
        instanceId: 'worker-1',
        outcome: 'blocked',
        summary: 'Blocked by a dependency.',
        ...({ transcript: 'must not persist', secret: 'must not persist' } as object),
      } as FleetControlRequest['result'],
    });
    expect(result).toMatchObject({ decision: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('must not persist');
    expect(service.ledger.getWorkItem('work-safe')?.result).toBeUndefined();
  });

  it('ingests normalized usage and quota without accepting raw runtime data', async () => {
    const service = new FleetControlService({ now: () => 100 });
    const response = await service.submit({
      ...base('record_telemetry', 'telemetry-record'),
      telemetry: {
        usage: {
          usageId: 'usage-1',
          instanceId: 'worker-1',
          runtime: 'codex-cli',
          capturedAt: 100,
          durationMs: 1200,
          tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          source: 'agentmetrics',
          availability: 'available',
          confidence: 'high',
          estimateOrActual: 'actual',
        },
        quota: {
          snapshotId: 'quota-1',
          runtime: 'codex-cli',
          window: 'daily',
          capturedAt: 100,
          remaining: { amount: 95, unit: 'requests' },
          source: 'agentmetrics',
          availability: 'available',
          confidence: 'medium',
          estimateOrActual: 'actual',
        },
      },
    });
    expect(response).toMatchObject({
      decision: 'accepted',
      telemetry: { usageId: 'usage-1', snapshotId: 'quota-1' },
    });
    expect(service.getMetrics()).toMatchObject({
      totals: { tokens: { totalTokens: 15 } },
    });
  });
});
