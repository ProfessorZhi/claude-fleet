import { describe, expect, it } from 'vitest';

import { toFleetWireIdentity, validateFleetIdentity } from '../../core/src/fleetContracts.js';
import {
  type FleetEvent,
  type FleetTelemetrySnapshot,
  FleetTelemetryStore,
  normalizeAgentBroadcast,
} from '../../core/src/fleetTelemetry.js';

function event(overrides: Partial<FleetEvent> = {}): FleetEvent {
  return {
    eventId: 'event-1',
    eventType: 'working',
    observedAt: 1,
    source: 'agent-state',
    instanceId: 'agent-1',
    runtime: 'claude-code',
    ...overrides,
  };
}

function seed(overrides: Partial<FleetTelemetrySnapshot> = {}): Partial<FleetTelemetrySnapshot> {
  return {
    instanceId: 'agent-7',
    agentId: 7,
    runtime: 'claude-code',
    managedByFleet: true,
    repo: 'F:/repo',
    sessionId: 'session-7',
    ...overrides,
  };
}

describe('FleetTelemetryStore', () => {
  it('deduplicates event ids and bounds global and per-instance history', () => {
    const store = new FleetTelemetryStore(2);

    store.consume(event({ eventId: 'e1', observedAt: 1, currentTool: 'Read' }));
    store.consume(event({ eventId: 'e1', eventType: 'waiting', observedAt: 2 }));
    store.consume(
      event({
        eventId: 'e2',
        eventType: 'tool_finished',
        observedAt: 2,
        currentTool: 'Read',
      }),
    );
    store.consume(event({ eventId: 'e3', eventType: 'waiting', observedAt: 3 }));

    const snapshot = store.getSnapshot('agent-1');
    expect(snapshot).toMatchObject({
      instanceId: 'agent-1',
      status: 'waiting',
      lastActivityAt: 3,
    });
    expect(snapshot?.currentTool).toBeUndefined();
    expect(snapshot?.recentEvents.map((item) => item.eventId)).toEqual(['e2', 'e3']);

    const projection = store.getProjection();
    expect(projection.recentEvents.map((item) => item.eventId)).toEqual(['e2', 'e3']);
  });

  it('keeps metadata and context usage when events arrive incrementally', () => {
    const store = new FleetTelemetryStore();

    store.consume(
      event({
        eventId: 'started',
        eventType: 'agent_started',
        observedAt: 10,
        managedByFleet: true,
        repo: 'F:/repo',
        sessionId: 'session-1',
        displayName: 'astrid',
        providerDisplayName: 'DeepSeek',
        modelId: 'deepseek-v4',
        role: 'worker',
      }),
    );
    store.consume(
      event({
        eventId: 'context',
        eventType: 'context_updated',
        observedAt: 11,
        contextUsage: { usedTokens: 70, limitTokens: 100 },
      }),
    );

    expect(store.getSnapshot('agent-1')).toMatchObject({
      managedByFleet: true,
      repo: 'F:/repo',
      sessionId: 'session-1',
      displayName: 'astrid',
      providerDisplayName: 'DeepSeek',
      modelId: 'deepseek-v4',
      contextUsage: { usedTokens: 70, limitTokens: 100 },
      recentEvents: expect.any(Array),
    });
  });

  it('does not forward unknown message fields such as secrets', () => {
    const normalized = normalizeAgentBroadcast(
      {
        id: 7,
        type: 'agentToolStart',
        toolName: 'Edit',
        apiKey: 'secret-api-key',
        authorization: 'Bearer secret-token',
        environment: { SECRET: 'secret-value' },
      },
      seed(),
    );

    expect(normalized).toMatchObject({
      eventType: 'tool_started',
      instanceId: 'agent-7',
      agentId: 7,
      currentTool: 'Edit',
    });
    expect(JSON.stringify(normalized)).not.toContain('secret-api-key');
    expect(JSON.stringify(normalized)).not.toContain('secret-token');
    expect(JSON.stringify(normalized)).not.toContain('secret-value');
  });

  it('ignores unknown broadcasts instead of inventing telemetry', () => {
    expect(
      normalizeAgentBroadcast({ id: 7, type: 'unknownFutureMessage' }, seed()),
    ).toBeUndefined();
    expect(normalizeAgentBroadcast({ type: 'agentStatus' }, seed())).toBeUndefined();
  });
});

describe('Fleet identity wire boundary', () => {
  it('accepts safe ids and emits snake_case metadata only', () => {
    const identity = {
      fleetRunId: 'run-1',
      fleetTaskId: 'task.1',
      fleetWorkerId: 'worker_1',
      workerRole: 'reviewer',
      attempt: 2,
    };

    expect(validateFleetIdentity(identity)).toBeNull();
    expect(toFleetWireIdentity(identity)).toEqual({
      fleet_run_id: 'run-1',
      fleet_task_id: 'task.1',
      fleet_worker_id: 'worker_1',
      worker_role: 'reviewer',
      attempt: 2,
    });
  });

  it('rejects unsafe identifiers and multiline role values', () => {
    expect(validateFleetIdentity({ fleetRunId: '../secret' })).toContain('safe identifier');
    expect(validateFleetIdentity({ workerRole: 'worker\nsecret' })).toContain('single-line');
    expect(validateFleetIdentity({ attempt: 0 })).toContain('positive integer');
  });
});
