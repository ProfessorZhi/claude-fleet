import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetControlRequest, FleetLaunchTemplate } from '../../core/src/controlContracts.js';
import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type { QualitySignal, QuotaSnapshot, UsageRecord } from '../../core/src/ledgerContracts.js';
import type {
  FleetInstance,
  FleetRuntime,
  FleetRuntimeHost,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  WorkItem,
} from '../../core/src/runtimeContracts.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { FleetControlClient } from '../../server/src/fleetControlClient.js';
import { FleetControlService } from '../../server/src/fleetControlService.js';
import { FleetLedgerStore } from '../../server/src/fleetLedgerStore.js';
import { InMemoryFleetSnapshotPersistence } from '../../server/src/persistence/fleetSnapshotPersistence.js';
import { createHttpServer, type HttpServerHandle } from '../../server/src/httpServer.js';

const CONTROL_TOKEN = 'fake-control-plane-token';
const COORDINATOR_ID = 'codex-coordinator';

interface BoundedTaskBrief {
  workItemId: string;
  missionId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
}

/**
 * This is deliberately a test-only task-delivery boundary. Production task
 * delivery is still a separate 017 implementation item; this contract proves
 * what a host may receive once that boundary is wired.
 */
class FakeTaskDeliveryBoundary {
  readonly attempts: Array<{ instanceId: string; workItemId: string }> = [];
  readonly delivered: Array<{ instanceId: string; brief: BoundedTaskBrief }> = [];

  async deliverWithRetry(
    instance: FleetInstance,
    workItem: WorkItem,
    maxAttempts: number,
    failFirst = false,
  ): Promise<void> {
    const brief: BoundedTaskBrief = {
      workItemId: workItem.workItemId,
      missionId: workItem.missionId,
      title: workItem.title,
      objective: workItem.objective,
      acceptanceCriteria: [...workItem.acceptanceCriteria],
    };
    const serialized = JSON.stringify(brief);
    assert(!serialized.includes('prompt'));
    assert(!serialized.includes('transcript'));
    assert(!serialized.includes('secret'));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.attempts.push({ instanceId: instance.instanceId, workItemId: workItem.workItemId });
      if (failFirst && attempt === 1) continue;
      this.delivered.push({ instanceId: instance.instanceId, brief });
      return;
    }
    throw new Error('fake task delivery exhausted retry budget');
  }
}

class FakeRuntime implements RuntimeAdapter {
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities = {
    launch: true,
    stop: true,
    focus: true,
    restart: true,
    resume: true,
    discover: true,
    structuredEvents: true,
    nativeSessionContinuity: true,
  };
  readonly launches: RuntimeLaunchRequest[] = [];
  readonly stops: string[] = [];
  readonly focuses: string[] = [];

  constructor(readonly runtime: FleetRuntime) {
    this.displayName = `Fake ${runtime}`;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async getVersion(): Promise<string> {
    return `fake-${this.runtime}-1.0.0`;
  }

  async buildLaunchSpec(request: RuntimeLaunchRequest): Promise<unknown> {
    return {
      runtime: request.instance.runtime,
      cwd: request.cwd,
      sessionMode: request.sessionMode,
      sessionId: request.sessionId,
    };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.launches.push(request);
    const sessionId = request.sessionId ?? `${this.runtime}-session-${request.instance.instanceId}`;
    return {
      instanceId: request.instance.instanceId,
      sessionId,
      terminalId: `${this.runtime}-terminal-${request.instance.instanceId}`,
      terminalName: `${this.displayName} ${request.instance.instanceId}`,
      startedAt: 100 + this.launches.length,
    };
  }

  async stop(instanceId: string): Promise<void> {
    this.stops.push(instanceId);
  }

  async focus(instanceId: string): Promise<void> {
    this.focuses.push(instanceId);
  }

  async restart(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return this.launch(request);
  }

  async resume(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return this.launch(request);
  }

  async discover(): Promise<ReadonlyArray<Partial<FleetInstance>>> {
    return [];
  }

  normalizeEvent(_input: unknown): FleetEvent | undefined {
    return undefined;
  }
}

class FakeRuntimeHost implements FleetRuntimeHost {
  readonly hostId: string;
  readonly hostType = 'fake-runtime-host';

  constructor(private readonly runtime: FakeRuntime) {
    this.hostId = `fake-host-${runtime.runtime}`;
  }

  launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return this.runtime.launch(request);
  }

  stop(instanceId: string): Promise<void> {
    return this.runtime.stop(instanceId);
  }

  focus(instanceId: string): Promise<void> {
    return this.runtime.focus(instanceId);
  }
}

function controlRequest(
  requestId: string,
  action: FleetControlRequest['action'],
  overrides: Partial<FleetControlRequest> = {},
): FleetControlRequest {
  return {
    requestId,
    action,
    mode: 'suggest',
    requestedBy: COORDINATOR_ID,
    createdAt: 1,
    ...overrides,
  };
}

function launchRequest(
  requestId: string,
  instanceId: string,
  runtime: FleetRuntime,
): FleetControlRequest {
  const template: FleetLaunchTemplate = {
    runtime,
    role: 'worker',
    repo: `F:/fake-repo/${runtime}`,
    cwd: `F:/fake-repo/${runtime}`,
    providerProfileId: `fake-${runtime}`,
    modelId: `fake-model-${runtime}`,
    sessionMode: 'new',
    requestedBy: COORDINATOR_ID,
    policy: { mode: 'approve', allowedRuntimeTypes: [runtime] },
  };
  return controlRequest(requestId, 'launch_instance', {
    mode: 'approve',
    instanceId,
    launch: template,
  });
}

function usage(runtime: FleetRuntime, instanceId: string, workItemId: string): UsageRecord {
  return {
    usageId: `usage-${runtime}`,
    instanceId,
    workItemId,
    runtime,
    capturedAt: 500,
    durationMs: runtime === 'claude-code' ? 40 : 50,
    tokens: runtime === 'claude-code' ? { totalTokens: 10 } : { totalTokens: 20 },
    cost: {
      amount: runtime === 'claude-code' ? 0.2 : 0.3,
      currency: 'USD',
      basis: 'api-equivalent',
    },
    source: 'agentmetrics',
    availability: 'available',
    confidence: 'exact',
    estimateOrActual: 'actual',
  };
}

function quality(runtime: FleetRuntime, workItemId: string): QualitySignal {
  return {
    signalId: `pr-${runtime}`,
    kind: 'pull-request',
    workItemId,
    instanceId: runtime === 'claude-code' ? 'claude-worker' : 'codex-worker',
    pullRequestId: runtime === 'claude-code' ? '101' : '102',
    outcome: 'passed',
    summary: `${runtime} PR passed fake CI and review evidence.`,
    metadata: { state: 'merged', ci: 'passed', review: 'approved' },
    capturedAt: 500,
    source: 'scm',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
  };
}

function quota(runtime: FleetRuntime): QuotaSnapshot {
  return {
    snapshotId: `quota-${runtime}`,
    runtime,
    window: 'daily',
    capturedAt: 500,
    used: { amount: runtime === 'claude-code' ? 10 : 20, unit: 'tokens' },
    remaining: { amount: runtime === 'claude-code' ? 990 : 980, unit: 'tokens' },
    source: 'resource',
    availability: 'available',
    confidence: 'high',
    estimateOrActual: 'actual',
  };
}

test('mixed Claude/Codex fake control-plane flow is bounded, auditable, and restorable', async () => {
  const persistence = new InMemoryFleetSnapshotPersistence();
  const claude = new FakeRuntime('claude-code');
  const codex = new FakeRuntime('codex-cli');
  const service = new FleetControlService({
    now: () => 1_000,
    ledger: new FleetLedgerStore({ persistence }),
    registrations: [
      { adapter: claude, host: new FakeRuntimeHost(claude) },
      { adapter: codex, host: new FakeRuntimeHost(codex) },
    ],
  });
  let handle: HttpServerHandle | undefined;

  try {
    handle = await createHttpServer({
      embedded: true,
      token: CONTROL_TOKEN,
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: CONTROL_TOKEN });

    const mission = await client.submit(
      controlRequest('create-mission', 'create_mission', {
        mission: {
          missionId: 'mission-mixed',
          title: 'Mixed runtime delivery',
          objective: 'Coordinate fake Claude and Codex workers without starting real agents.',
          policyMode: 'approve',
          repoScope: ['F:/fake-repo'],
        },
      }),
    );
    assert.equal(mission.decision, 'accepted');

    const claudeLaunch = await client.submit(
      launchRequest('launch-claude', 'claude-worker', 'claude-code'),
    );
    const codexLaunch = await client.submit(
      launchRequest('launch-codex', 'codex-worker', 'codex-cli'),
    );
    assert.equal(claudeLaunch.decision, 'accepted');
    assert.equal(codexLaunch.decision, 'accepted');

    const claudeWork: WorkItem = {
      workItemId: 'work-claude',
      missionId: 'mission-mixed',
      title: 'Claude implementation slice',
      objective: 'Implement the Claude worker slice.',
      acceptanceCriteria: ['fake Claude receives bounded brief'],
      status: 'queued',
      allowedRuntimeTypes: ['claude-code'],
      createdAt: 10,
    };
    const codexWork: WorkItem = {
      workItemId: 'work-codex',
      missionId: 'mission-mixed',
      title: 'Codex review slice',
      objective: 'Review the implementation from the Codex worker.',
      acceptanceCriteria: ['fake Codex receives bounded brief'],
      status: 'queued',
      allowedRuntimeTypes: ['codex-cli'],
      createdAt: 10,
    };
    for (const [requestId, workItem] of [
      ['create-work-claude', claudeWork],
      ['create-work-codex', codexWork],
    ] as const) {
      const created = await client.submit(
        controlRequest(requestId, 'create_work_item', {
          missionId: workItem.missionId,
          workItemId: workItem.workItemId,
          workItem: {
            workItemId: workItem.workItemId,
            missionId: workItem.missionId,
            title: workItem.title,
            objective: workItem.objective,
            acceptanceCriteria: workItem.acceptanceCriteria,
            allowedRuntimeTypes: workItem.allowedRuntimeTypes,
          },
        }),
      );
      assert.equal(created.decision, 'accepted');
    }

    for (const [requestId, workItem] of [
      ['recommend-claude', claudeWork],
      ['recommend-codex', codexWork],
    ] as const) {
      const recommendation = await client.submit(
        controlRequest(requestId, 'recommend_assignment', {
          mode: 'suggest',
          missionId: workItem.missionId,
          workItemId: workItem.workItemId,
          strategy: {
            now: 20,
            workItem,
            policy: { mode: 'suggest', allowedRuntimeTypes: workItem.allowedRuntimeTypes },
          },
        }),
      );
      assert.equal(recommendation.decision, 'accepted');
      assert.equal(
        recommendation.recommendation?.selectedInstanceId,
        workItem.workItemId === 'work-claude' ? 'claude-worker' : 'codex-worker',
      );
    }

    const claudeAssignment = await client.submit(
      controlRequest('assign-claude', 'assign_work_item', {
        mode: 'approve',
        missionId: 'mission-mixed',
        workItemId: 'work-claude',
        instanceId: 'claude-worker',
      }),
    );
    const codexAssignment = await client.submit(
      controlRequest('assign-codex', 'assign_work_item', {
        mode: 'approve',
        missionId: 'mission-mixed',
        workItemId: 'work-codex',
        instanceId: 'codex-worker',
      }),
    );
    assert.equal(claudeAssignment.decision, 'accepted');
    assert.equal(codexAssignment.decision, 'accepted');

    const delivery = new FakeTaskDeliveryBoundary();
    await delivery.deliverWithRetry(
      (await service.getInstance('claude-worker'))!,
      (await service.getWorkItem('work-claude'))!,
      1,
    );
    await delivery.deliverWithRetry(
      (await service.getInstance('codex-worker'))!,
      (await service.getWorkItem('work-codex'))!,
      2,
      true,
    );
    assert.deepEqual(delivery.attempts, [
      { instanceId: 'claude-worker', workItemId: 'work-claude' },
      { instanceId: 'codex-worker', workItemId: 'work-codex' },
      { instanceId: 'codex-worker', workItemId: 'work-codex' },
    ]);
    assert.equal(delivery.delivered.length, 2);

    const claudeResult = controlRequest('collect-claude', 'collect_result', {
      workItemId: 'work-claude',
      result: {
        workItemId: 'work-claude',
        instanceId: 'claude-worker',
        outcome: 'completed',
        summary: 'Claude fake completed the implementation slice.',
        artifactRefs: ['commit:fake-claude-1'],
        source: 'runtime',
        availability: 'available',
        confidence: 'exact',
      },
    });
    const codexResult = controlRequest('collect-codex', 'collect_result', {
      workItemId: 'work-codex',
      result: {
        workItemId: 'work-codex',
        instanceId: 'codex-worker',
        outcome: 'completed',
        summary: 'Codex fake completed the review slice.',
        artifactRefs: ['commit:fake-codex-1'],
        source: 'runtime',
        availability: 'available',
        confidence: 'exact',
      },
    });
    assert.equal((await client.submit(claudeResult)).decision, 'accepted');
    assert.equal((await client.submit(codexResult)).decision, 'accepted');
    assert.deepEqual(await client.submit(codexResult), await client.submit(codexResult));

    for (const [requestId, record] of [
      ['telemetry-claude', usage('claude-code', 'claude-worker', 'work-claude')],
      ['telemetry-codex', usage('codex-cli', 'codex-worker', 'work-codex')],
    ] as const) {
      const telemetry = controlRequest(requestId, 'record_telemetry', {
        telemetry: { usage: record, quota: quota(record.runtime) },
      });
      assert.equal((await client.submit(telemetry)).decision, 'accepted');
      assert.deepEqual(await client.submit(telemetry), await client.submit(telemetry));
    }

    for (const [requestId, record] of [
      ['quality-claude', quality('claude-code', 'work-claude')],
      ['quality-codex', quality('codex-cli', 'work-codex')],
    ] as const) {
      const evidence = controlRequest(requestId, 'record_quality', {
        mode: 'approve',
        workItemId: record.workItemId,
        quality: record,
      });
      assert.equal((await client.submit(evidence)).decision, 'accepted');
    }

    const metrics = await client.getMetrics();
    assert.deepEqual(metrics.totals.tokens, { totalTokens: 30 });
    assert.deepEqual(metrics.totals.cost, {
      amount: 0.5,
      currency: 'USD',
      basis: 'api-equivalent',
    });
    assert.equal(metrics.usage.length, 2);
    assert.equal(metrics.quotas.length, 2);
    assert.equal(metrics.sessions.length, 2);
    assert.equal((await client.getQuality()).length, 2);
    assert.equal((await client.getMetrics(undefined, 'work-claude')).totals.cost?.amount, 0.2);

    const roster = await client.listInstances();
    assert.deepEqual(roster.map((instance) => [instance.instanceId, instance.runtime]).sort(), [
      ['claude-worker', 'claude-code'],
      ['codex-worker', 'codex-cli'],
    ]);
    assert.equal(service.ledger.listAssignments().length, 4);
    assert.equal(service.ledger.listControlDecisions().length, 15);

    const restored = new FleetControlService({
      now: () => 1_000,
      ledger: new FleetLedgerStore({ persistence }),
      instances: service.listInstances(),
      registrations: [
        { adapter: claude, host: new FakeRuntimeHost(claude) },
        { adapter: codex, host: new FakeRuntimeHost(codex) },
      ],
    });
    assert.equal((await restored.getMission('mission-mixed'))?.status, 'active');
    assert.equal((await restored.getWorkItem('work-claude'))?.status, 'completed');
    assert.equal((await restored.getWorkItem('work-codex'))?.status, 'completed');
    assert.equal(restored.getMetrics().usage.length, 2);
    assert.equal(restored.getMetrics().totals.tokens.totalTokens, 30);
    assert.equal(restored.getMetrics().totals.cost?.amount, 0.5);
    assert.equal(restored.getQuality().length, 2);
  } finally {
    await handle?.app.close();
  }
});

test('mixed control-plane HTTP boundary rejects missing auth and does not expose token fields', async () => {
  const service = new FleetControlService({ now: () => 1_000 });
  const handle = await createHttpServer({
    embedded: true,
    token: CONTROL_TOKEN,
    store: new AgentStateStore(),
    controlApi: service,
  });
  try {
    const request = controlRequest('auth-boundary', 'create_mission', {
      mission: {
        missionId: 'mission-auth',
        title: 'Auth boundary',
        objective: 'Check local auth and response redaction.',
        policyMode: 'suggest',
      },
      // This field is intentionally outside the contract and must not cross
      // the response boundary if a future implementation echoes unknown data.
      metadata: { authorization: CONTROL_TOKEN, prompt: 'do not persist this' },
    } as Partial<FleetControlRequest>);
    const unauthenticated = await fetch(`http://127.0.0.1:${handle.port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/control`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONTROL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert(!body.includes(CONTROL_TOKEN));
    assert(!body.includes('authorization'));
    assert(!body.includes('prompt'));
  } finally {
    await handle.app.close();
  }
});
