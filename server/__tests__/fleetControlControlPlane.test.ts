import { afterEach, describe, expect, it } from 'vitest';

import type { FleetControlRequest, FleetLaunchTemplate } from '../../core/src/controlContracts.js';
import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type { QuotaSnapshot, SessionRecord, UsageRecord } from '../../core/src/ledgerContracts.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FleetControlClient } from '../src/fleetControlClient.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';

const TOKEN = 'control-plane-test-token';

class FakeClaudeRuntime implements RuntimeAdapter {
  readonly runtime = 'claude-code' as const;
  readonly displayName = 'Fake Claude Code';
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

  async detect(): Promise<boolean> {
    return true;
  }

  async getVersion(): Promise<string> {
    return 'fake-claude-for-tests';
  }

  async buildLaunchSpec(request: RuntimeLaunchRequest): Promise<unknown> {
    return {
      runtime: request.instance.runtime,
      cwd: request.cwd,
      sessionMode: request.sessionMode,
      sessionId: request.sessionId,
      providerProfileId: request.providerProfileId,
      modelId: request.modelId,
    };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.launches.push(request);
    const sessionId = request.sessionId ?? `session-${request.instance.instanceId}`;
    return {
      instanceId: request.instance.instanceId,
      sessionId,
      terminalId: `terminal-${request.instance.instanceId}`,
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
  readonly hostId = 'fake-local-host';
  readonly hostType = 'fake-local-host';

  constructor(private readonly runtime: FakeClaudeRuntime) {}

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

function launchTemplate(
  instanceId: string,
  overrides: Partial<FleetLaunchTemplate> = {},
): FleetLaunchTemplate {
  return {
    runtime: 'claude-code',
    role: 'worker',
    repo: `F:/repo-${instanceId}`,
    cwd: `F:/repo-${instanceId}`,
    providerProfileId: `provider-${instanceId}`,
    modelId: `model-${instanceId}`,
    sessionMode: 'new',
    requestedBy: 'local-test',
    policy: { mode: 'approve' },
    ...overrides,
  };
}

function launchRequest(
  requestId: string,
  instanceId: string,
  overrides: Partial<FleetLaunchTemplate> = {},
): FleetControlRequest {
  return {
    requestId,
    action: 'launch_instance',
    mode: 'approve',
    requestedBy: 'local-test',
    instanceId,
    launch: launchTemplate(instanceId, overrides),
    createdAt: 1,
  };
}

describe('Fleet Control API local HTTP lifecycle', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  it('launches independent instances and isolates focus/stop over local HTTP', async () => {
    const runtime = new FakeClaudeRuntime();
    const service = new FleetControlService({
      now: () => 200,
      registrations: [{ adapter: runtime, host: new FakeRuntimeHost(runtime) }],
    });
    handle = await createHttpServer({
      embedded: true,
      token: TOKEN,
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: TOKEN });

    const requestA = launchRequest('launch-a', 'instance-a');
    const requestB = launchRequest('launch-b', 'instance-b');
    const launchedA = await client.submit(requestA);
    const launchedB = await client.submit(requestB);

    expect(launchedA).toMatchObject({
      decision: 'accepted',
      instance: {
        instanceId: 'instance-a',
        repo: 'F:/repo-instance-a',
        workspaceId: 'F:/repo-instance-a',
        sessionId: 'session-instance-a',
        providerProfileId: 'provider-instance-a',
        modelId: 'model-instance-a',
      },
    });
    expect(launchedB).toMatchObject({
      decision: 'accepted',
      instance: {
        instanceId: 'instance-b',
        repo: 'F:/repo-instance-b',
        workspaceId: 'F:/repo-instance-b',
        sessionId: 'session-instance-b',
        providerProfileId: 'provider-instance-b',
        modelId: 'model-instance-b',
      },
    });
    expect(
      runtime.launches.map((request) => ({
        instanceId: request.instance.instanceId,
        cwd: request.cwd,
        sessionMode: request.sessionMode,
        providerProfileId: request.providerProfileId,
        modelId: request.modelId,
      })),
    ).toEqual([
      {
        instanceId: 'instance-a',
        cwd: 'F:/repo-instance-a',
        sessionMode: 'new',
        providerProfileId: 'provider-instance-a',
        modelId: 'model-instance-a',
      },
      {
        instanceId: 'instance-b',
        cwd: 'F:/repo-instance-b',
        sessionMode: 'new',
        providerProfileId: 'provider-instance-b',
        modelId: 'model-instance-b',
      },
    ]);

    await expect(client.listInstances()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: 'instance-a' }),
        expect.objectContaining({ instanceId: 'instance-b' }),
      ]),
    );

    const restartedB = await client.submit({
      requestId: 'restart-b',
      action: 'restart_instance',
      mode: 'approve',
      requestedBy: 'local-test',
      instanceId: 'instance-b',
      createdAt: 2,
    });
    expect(restartedB).toMatchObject({
      decision: 'accepted',
      instance: { instanceId: 'instance-b', sessionId: 'session-instance-b' },
      launchResult: { instanceId: 'instance-b' },
    });

    const focused = await client.submit({
      requestId: 'focus-a',
      action: 'focus_instance',
      mode: 'approve',
      requestedBy: 'local-test',
      instanceId: 'instance-a',
      createdAt: 2,
    });
    const stopped = await client.submit({
      requestId: 'stop-a',
      action: 'stop_instance',
      mode: 'approve',
      requestedBy: 'local-test',
      instanceId: 'instance-a',
      createdAt: 3,
    });

    expect(focused.decision).toBe('accepted');
    expect(stopped).toMatchObject({
      decision: 'accepted',
      instance: { instanceId: 'instance-a', status: 'stopped' },
    });
    expect(runtime.focuses).toEqual(['instance-a']);
    expect(runtime.stops).toEqual(['instance-b', 'instance-a']);

    const resumedA = await client.submit({
      requestId: 'resume-a',
      action: 'resume_instance',
      mode: 'approve',
      requestedBy: 'local-test',
      instanceId: 'instance-a',
      createdAt: 4,
    });
    expect(resumedA).toMatchObject({
      decision: 'accepted',
      instance: { instanceId: 'instance-a', sessionId: 'session-instance-a' },
    });
    expect(runtime.launches.at(-1)).toMatchObject({
      instance: { instanceId: 'instance-a' },
      sessionMode: 'resume',
      sessionId: 'session-instance-a',
    });
    expect(await client.getInstance('instance-a')).toMatchObject({ status: 'starting' });
    expect(await client.getInstance('instance-b')).toMatchObject({
      instanceId: 'instance-b',
      status: 'starting',
      repo: 'F:/repo-instance-b',
      sessionId: 'session-instance-b',
    });
    expect(service.ledger.listControlDecisions('launch-a')[0]).toMatchObject({
      action: 'launch_instance',
      decision: 'accepted',
      instanceId: 'instance-a',
    });
    expect(service.ledger.listControlDecisions('stop-a')[0]).toMatchObject({
      action: 'stop_instance',
      decision: 'accepted',
      instanceId: 'instance-a',
    });
    expect(service.ledger.listControlDecisions('restart-b')[0]).toMatchObject({
      action: 'restart_instance',
      decision: 'accepted',
    });
    expect(service.ledger.listControlDecisions('resume-a')[0]).toMatchObject({
      action: 'resume_instance',
      decision: 'accepted',
    });
  });

  it('enforces policy, duplicate requests, unknown ids, and malformed/auth boundaries', async () => {
    const runtime = new FakeClaudeRuntime();
    const service = new FleetControlService({
      now: () => 300,
      registrations: [{ adapter: runtime, host: new FakeRuntimeHost(runtime) }],
    });
    handle = await createHttpServer({
      embedded: true,
      token: TOKEN,
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: TOKEN });

    const firstRequest = launchRequest('duplicate-launch', 'instance-1');
    const first = await client.submit(firstRequest);
    const duplicate = await client.submit(firstRequest);
    expect(duplicate).toEqual(first);
    expect(runtime.launches).toHaveLength(1);
    expect(service.ledger.listControlDecisions('duplicate-launch')).toHaveLength(1);

    const denied = await client.submit(
      launchRequest('policy-denied', 'instance-2', {
        policy: { mode: 'approve', maxConcurrentInstances: 1 },
      }),
    );
    expect(denied).toMatchObject({
      decision: 'rejected',
      reason: 'Maximum concurrent instance limit reached.',
    });
    expect(runtime.launches).toHaveLength(1);
    expect(service.ledger.listControlDecisions('policy-denied')[0]).toMatchObject({
      decision: 'rejected',
      reason: 'Maximum concurrent instance limit reached.',
    });

    const unknownStop = await client.submit({
      requestId: 'unknown-stop',
      action: 'stop_instance',
      mode: 'approve',
      requestedBy: 'local-test',
      instanceId: 'does-not-exist',
      createdAt: 4,
    });
    expect(unknownStop).toMatchObject({ decision: 'unavailable', reason: 'Instance not found.' });
    await expect(client.getInstance('does-not-exist')).resolves.toBeUndefined();

    const unauthenticated = await fetch(`http://127.0.0.1:${handle.port}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firstRequest),
    });
    expect(unauthenticated.status).toBe(401);

    const malformed = await fetch(`http://127.0.0.1:${handle.port}/api/control`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([]),
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'invalid_control_request' });
  });

  it('exposes token, quota, and elapsed-time measurements without mixing evidence sources', async () => {
    const service = new FleetControlService({ now: () => 1_000 });
    const session: SessionRecord = {
      sessionId: 'session-1',
      instanceId: 'instance-1',
      runtime: 'claude-code',
      managedByFleet: true,
      status: 'active',
      startedAt: 400,
    };
    const usage: UsageRecord = {
      usageId: 'usage-1',
      instanceId: 'instance-1',
      sessionId: session.sessionId,
      capturedAt: 900,
      durationMs: 250,
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      source: 'agentmetrics',
      availability: 'available',
      confidence: 'exact',
      estimateOrActual: 'actual',
    };
    const quota: QuotaSnapshot = {
      snapshotId: 'quota-1',
      resourceAccountId: 'account-1',
      window: 'weekly',
      capturedAt: 900,
      used: { amount: 15, unit: 'tokens' },
      remaining: { amount: 985, unit: 'tokens' },
      source: 'resource',
      availability: 'available',
      confidence: 'high',
      estimateOrActual: 'actual',
    };
    service.ledger.upsertSession(session);
    service.ledger.recordUsage(usage);
    service.ledger.recordQuota(quota);
    handle = await createHttpServer({
      embedded: true,
      token: TOKEN,
      store: new AgentStateStore(),
      controlApi: service,
    });
    const client = new FleetControlClient({ port: handle.port, token: TOKEN });

    const metrics = await client.getMetrics('instance-1');
    expect(metrics).toMatchObject({
      instanceId: 'instance-1',
      totals: { durationMs: 600, tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    });
    expect(metrics.usage[0]).toMatchObject({ source: 'agentmetrics', durationMs: 250 });
    expect(metrics.quotas[0]).toMatchObject({
      resourceAccountId: 'account-1',
      remaining: { amount: 985, unit: 'tokens' },
    });
    expect(JSON.stringify(metrics)).not.toContain(TOKEN);
  });
});
