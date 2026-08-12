import { describe, expect, it, vi } from 'vitest';

import type { FleetRuntimeHost, RuntimeTaskBrief } from '../../core/src/runtimeContracts.js';
import {
  deliverRuntimeTask,
  renderRuntimeTaskBrief,
  validateRuntimeTaskBrief,
} from '../src/runtimeTaskDelivery.js';

const task: RuntimeTaskBrief = {
  workItemId: 'work-17',
  title: 'Implement bounded delivery',
  objective: 'Send a safe work brief to the managed terminal.',
  acceptanceCriteria: [
    'Only the four approved fields are accepted.',
    'No unapproved payload is persisted.',
  ],
};

function host(sendTask?: FleetRuntimeHost['sendTask']): Pick<FleetRuntimeHost, 'sendTask'> {
  return { sendTask };
}

describe('runtime task delivery boundary', () => {
  it('renders only the bounded work brief fields', () => {
    const rendered = renderRuntimeTaskBrief(task);

    expect(rendered).toContain('[Claude Fleet WorkItem work-17]');
    expect(rendered).toContain('Title: Implement bounded delivery');
    expect(rendered).toContain('Objective: Send a safe work brief');
    expect(rendered).toContain('- Only the four approved fields are accepted.');
    expect(rendered).not.toContain('rawPrompt');
    expect(rendered).not.toContain('transcript');
    expect(rendered).not.toContain('secret');
  });

  it('rejects raw prompt, transcript, and secret fields', () => {
    for (const forbiddenField of ['rawPrompt', 'transcript', 'secret']) {
      expect(() =>
        validateRuntimeTaskBrief({ ...task, [forbiddenField]: 'must not cross boundary' }),
      ).toThrow(/only workItemId/);
    }

    expect(() =>
      validateRuntimeTaskBrief({
        ...task,
        objective: 'Use apiKey=do-not-send to complete the task.',
      }),
    ).toThrow(/sensitive material/);
  });

  it('rejects unbounded criteria and malformed briefs', () => {
    expect(() => validateRuntimeTaskBrief({ ...task, acceptanceCriteria: [] })).toThrow(
      /count is outside the bound/,
    );
    expect(() =>
      validateRuntimeTaskBrief({
        ...task,
        objective: 'x'.repeat(2_001),
      }),
    ).toThrow(/bounded length/);
  });

  it('returns unavailable without a task boundary and does not invoke a CLI', async () => {
    const result = await deliverRuntimeTask(undefined, {
      instanceId: 'agent-1',
      task,
    });

    expect(result).toEqual({
      instanceId: 'agent-1',
      workItemId: 'work-17',
      status: 'unavailable',
      lifecycle: 'failed',
      reason: 'boundary_unavailable',
    });
  });

  it('delivers a normalized brief through the injected host boundary', async () => {
    const sendTask = vi.fn(async (_instanceId: string, received: RuntimeTaskBrief) => {
      expect(Object.keys(received).sort()).toEqual([
        'acceptanceCriteria',
        'objective',
        'title',
        'workItemId',
      ]);
    });
    const result = await deliverRuntimeTask(
      host(sendTask),
      { instanceId: 'agent-1', task },
      () => 123,
    );

    expect(result).toEqual({
      instanceId: 'agent-1',
      workItemId: 'work-17',
      status: 'delivered',
      lifecycle: 'delivered_to_runtime',
      deliveredAt: 123,
    });
    expect(sendTask).toHaveBeenCalledWith('agent-1', task);
  });

  it('maps host failures to safe unavailable without exposing the error', async () => {
    const result = await deliverRuntimeTask(
      host(async () => {
        throw new Error('terminal secret=must-not-leak');
      }),
      { instanceId: 'agent-1', task },
    );

    expect(result).toEqual({
      instanceId: 'agent-1',
      workItemId: 'work-17',
      status: 'unavailable',
      lifecycle: 'failed',
      reason: 'host_failed',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
});
