import { describe, expect, test } from 'vitest';

import { VisualAnimationController } from '../src/fleet/animation/controller.js';

describe('VisualAnimationController', () => {
  test('maps transient Fleet events to finite effects without React state', () => {
    const controller = new VisualAnimationController();
    const snapshot = controller.consume(
      {
        eventId: 'task-1',
        eventType: 'task_finished',
        agentId: 3,
      },
      1000,
    );

    expect(snapshot.effects).toMatchObject([
      { kind: 'task-finished-pulse', target: { agentId: 3 }, progress: 0 },
    ]);
    expect(controller.snapshot(1900).effects).toHaveLength(0);
  });

  test('creates and removes a finite subagent drone', () => {
    const controller = new VisualAnimationController({
      durations: { drone: 1000 },
    });
    controller.consume(
      {
        eventId: 'sub-1',
        eventType: 'subagent_started',
        agentId: 2,
        subagentId: 'drone-1',
      },
      100,
    );
    expect(controller.snapshot(500).drones[0]).toMatchObject({ id: 'drone-1', progress: 0.4 });

    controller.consume(
      {
        eventId: 'sub-2',
        eventType: 'subagent_finished',
        agentId: 2,
        subagentId: 'drone-1',
      },
      600,
    );
    expect(controller.snapshot(600).drones).toHaveLength(0);
    expect(controller.snapshot(600).effects.at(-1)?.kind).toBe('subagent-return');
  });

  test('deduplicates events and bounds retained effects', () => {
    const controller = new VisualAnimationController({ maxEffects: 2 });
    const event = { eventId: 'tool-1', eventType: 'tool_started' as const, agentId: 1 };
    controller.consume(event, 0);
    controller.consume(event, 1);
    controller.consume({ ...event, eventId: 'tool-2' }, 2);
    controller.consume({ ...event, eventId: 'tool-3' }, 3);

    expect(controller.snapshot(3).effects).toHaveLength(2);
  });

  test('supports provider and session transient events', () => {
    const controller = new VisualAnimationController();
    const snapshot = controller.consume(
      {
        eventType: 'provider_switched',
        agentId: 4,
        providerDisplayName: 'Codex',
      },
      10,
    );
    controller.consume({ eventType: 'session_resumed', agentId: 4 }, 20);

    expect(snapshot.effects[0]).toMatchObject({
      kind: 'provider-switched-pulse',
      metadata: { provider: 'Codex' },
    });
    expect(controller.snapshot(20).effects.map((effect) => effect.kind)).toEqual([
      'provider-switched-pulse',
      'session-resumed-pulse',
    ]);
  });
});
