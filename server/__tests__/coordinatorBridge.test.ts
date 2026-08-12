import { describe, expect, it } from 'vitest';

import type {
  FleetControlRequest,
  FleetControlResponse,
  FleetMetricsSnapshot,
} from '../../core/src/controlContracts.js';
import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import { CoordinatorBridge } from '../src/coordinatorBridge.js';
import { FleetControlService } from '../src/fleetControlService.js';

const now = 1_700_000_000_000;

function response(request: FleetControlRequest, extra: Partial<FleetControlResponse> = {}) {
  return {
    requestId: request.requestId,
    decision: 'accepted' as const,
    acceptedAt: now,
    ...extra,
  };
}

function instance(request: FleetControlRequest): FleetInstance {
  return {
    instanceId: request.instanceId!,
    displayName: request.launch?.displayName,
    runtime: request.launch!.runtime,
    role: request.launch!.role,
    managedByFleet: true,
    missionId: request.missionId,
    workItemId: request.workItemId,
    repo: request.launch!.repo,
    workspaceId: request.launch!.cwd,
    terminalId: `terminal-${request.instanceId}`,
    terminalName: request.launch!.runtime + '-' + request.instanceId,
    sessionId: `session-${request.instanceId}`,
    status: 'starting',
    createdAt: now,
  };
}

describe('CoordinatorBridge', () => {
  it('launches Claude and Codex workers as separate managed terminals and delivers bounded work briefs', async () => {
    const requests: FleetControlRequest[] = [];
    const control = {
      async submit(request: FleetControlRequest): Promise<FleetControlResponse> {
        requests.push(request);
        switch (request.action) {
          case 'create_mission':
            return response(request, {
              mission: { ...request.mission!, status: 'planned', createdAt: now },
            });
          case 'create_work_item':
            return response(request, {
              workItem: { ...request.workItem!, status: 'queued', createdAt: now },
            });
          case 'launch_instance':
            return response(request, {
              instance: instance(request),
              launchResult: {
                instanceId: request.instanceId!,
                sessionId: `session-${request.instanceId}`,
                terminalId: `terminal-${request.instanceId}`,
                terminalName: `${request.launch!.runtime}-${request.instanceId}`,
                startedAt: now,
              },
            });
          case 'assign_work_item':
            return response(request);
          case 'deliver_work_item':
            return response(request, {
              delivery: {
                instanceId: request.instanceId!,
                workItemId: request.workItemId!,
                status: 'delivered',
                lifecycle: 'delivered_to_runtime',
                deliveredAt: now,
              },
            });
          default:
            throw new Error(`Unexpected action ${request.action}`);
        }
      },
      listInstances: async () => [],
      getMetrics: async () => emptyMetrics(),
    };

    const bridge = new CoordinatorBridge(control, 'codex-primary-session', {
      now: () => now,
      requestIdPrefix: 'test-coordinator',
    });
    const result = await bridge.execute({
      requestedBy: 'codex-primary-session',
      mission: {
        missionId: 'mission-auth',
        title: 'Auth refactor',
        objective: 'Coordinate isolated runtime workers.',
        policyMode: 'approve',
      },
      workers: [
        {
          instanceId: 'claude-worker-1',
          launch: {
            runtime: 'claude-code',
            role: 'worker',
            displayName: 'Claude Worker 1',
            repo: 'agent-fleet',
            cwd: 'F:/work/claude-1',
            providerProfileId: 'deepseek.msk2hxew',
            modelId: 'deepseek-v4-flash',
            terminalPolicy: 'new',
            sessionMode: 'new',
          },
          workItem: {
            workItemId: 'work-auth-claude',
            title: 'Claude implementation',
            objective: 'Implement the auth change.',
            acceptanceCriteria: ['Tests pass.'],
            repo: 'agent-fleet',
          },
        },
        {
          instanceId: 'codex-worker-1',
          launch: {
            runtime: 'codex-cli',
            role: 'reviewer',
            displayName: 'Codex Reviewer 1',
            repo: 'agent-fleet',
            cwd: 'F:/work/codex-1',
            terminalPolicy: 'new',
            sessionMode: 'new',
          },
          workItem: {
            workItemId: 'work-auth-codex',
            title: 'Codex review',
            objective: 'Review the auth change.',
            acceptanceCriteria: ['Review notes are captured.'],
            repo: 'agent-fleet',
          },
        },
      ],
    });

    expect(result.workers).toHaveLength(2);
    expect(result.workers.map((worker) => worker.launch.instance?.runtime)).toEqual([
      'claude-code',
      'codex-cli',
    ]);
    expect(result.workers.every((worker) => worker.assignment?.decision === 'accepted')).toBe(true);
    expect(
      result.workers.every((worker) => worker.delivery?.delivery?.status === 'delivered'),
    ).toBe(true);

    const launches = requests.filter((request) => request.action === 'launch_instance');
    expect(launches.map((request) => request.instanceId)).toEqual([
      'claude-worker-1',
      'codex-worker-1',
    ]);
    expect(launches.map((request) => request.launch?.terminalPolicy)).toEqual(['new', 'new']);
    expect(launches.map((request) => request.launch?.providerProfileId)).toEqual([
      'deepseek.msk2hxew',
      undefined,
    ]);
    expect(launches.map((request) => request.launch?.modelId)).toEqual([
      'deepseek-v4-flash',
      undefined,
    ]);
    expect(launches.every((request) => request.requestedBy === 'codex-primary-session')).toBe(true);
    expect(
      launches.every((request) => request.launch?.requestedBy === 'codex-primary-session'),
    ).toBe(true);
    expect(launches.every((request) => request.launch?.policy.mode === 'approve')).toBe(true);

    const deliveredBriefs = requests
      .filter((request) => request.action === 'create_work_item')
      .map((request) => request.workItem);
    expect(deliveredBriefs).toEqual([
      expect.objectContaining({ workItemId: 'work-auth-claude', title: 'Claude implementation' }),
      expect.objectContaining({ workItemId: 'work-auth-codex', title: 'Codex review' }),
    ]);
    expect(deliveredBriefs[0]).not.toHaveProperty('prompt');
  });

  it('keeps management actions on the same Control API boundary', async () => {
    const requests: FleetControlRequest[] = [];
    const control = {
      async submit(request: FleetControlRequest): Promise<FleetControlResponse> {
        requests.push(request);
        return response(request);
      },
      listInstances: async () => [],
      getMetrics: async () => emptyMetrics(),
    };
    const bridge = new CoordinatorBridge(control, 'codex-primary-session', { now: () => now });

    await bridge.focus('claude-worker-1');
    await bridge.stop('claude-worker-1');
    await bridge.restart('codex-worker-1');
    await bridge.resume('codex-worker-1');

    expect(requests.map((request) => request.action)).toEqual([
      'focus_instance',
      'stop_instance',
      'restart_instance',
      'resume_instance',
    ]);
    expect(requests.every((request) => request.requestedBy === 'codex-primary-session')).toBe(true);
    expect(requests.every((request) => request.mode === 'approve')).toBe(true);
  });

  it('drives two registered runtime hosts through FleetControlService', async () => {
    const claude = new TestRuntime('claude-code');
    const codex = new TestRuntime('codex-cli');
    const service = new FleetControlService({
      now: () => now,
      registrations: [claude.registration(), codex.registration()],
    });
    const bridge = new CoordinatorBridge(service, 'codex-primary-session', { now: () => now });

    const result = await bridge.execute({
      requestedBy: 'codex-primary-session',
      mission: {
        missionId: 'mission-integration',
        title: 'Integration smoke',
        objective: 'Verify one VS Code host can own both runtimes.',
        policyMode: 'approve',
      },
      workers: [
        {
          instanceId: 'claude-integration-1',
          launch: {
            runtime: 'claude-code',
            role: 'worker',
            repo: 'agent-fleet',
            cwd: 'F:/work/claude-integration',
            providerProfileId: 'claude-fleet.inherit',
            modelId: 'claude-test-model',
            terminalPolicy: 'new',
            sessionMode: 'new',
          },
          workItem: {
            workItemId: 'work-integration-claude',
            title: 'Claude smoke task',
            objective: 'Run the Claude smoke task.',
            acceptanceCriteria: ['Task reaches the host.'],
            repo: 'agent-fleet',
          },
        },
        {
          instanceId: 'codex-integration-1',
          launch: {
            runtime: 'codex-cli',
            role: 'reviewer',
            repo: 'agent-fleet',
            cwd: 'F:/work/codex-integration',
            terminalPolicy: 'new',
            sessionMode: 'new',
          },
          workItem: {
            workItemId: 'work-integration-codex',
            title: 'Codex smoke task',
            objective: 'Run the Codex smoke task.',
            acceptanceCriteria: ['Task reaches the host.'],
            repo: 'agent-fleet',
          },
        },
      ],
    });

    expect(result.workers.every((worker) => worker.delivery?.decision === 'accepted')).toBe(true);
    expect(service.listInstances().map((item) => item.instanceId)).toEqual([
      'claude-integration-1',
      'codex-integration-1',
    ]);
    expect(claude.tasks).toEqual(['work-integration-claude']);
    expect(codex.tasks).toEqual(['work-integration-codex']);
    expect(claude.launches[0]?.instance.runtime).toBe('claude-code');
    expect(codex.launches[0]?.instance.runtime).toBe('codex-cli');
  });
});

class TestRuntime {
  readonly launches: Array<{ instance: FleetInstance }> = [];
  readonly tasks: string[] = [];

  constructor(readonly runtime: 'claude-code' | 'codex-cli') {}

  registration() {
    const adapter = {
      runtime: this.runtime,
      displayName: this.runtime,
      capabilities: {
        launch: true,
        stop: true,
        focus: true,
        restart: true,
        resume: true,
        discover: true,
        structuredEvents: true,
        nativeSessionContinuity: true,
      },
      detect: async () => true,
      getVersion: async () => 'test-runtime',
      buildLaunchSpec: async () => ({}),
      launch: async (request: { instance: FleetInstance }) => {
        this.launches.push({ instance: request.instance });
        return {
          instanceId: request.instance.instanceId,
          sessionId: `session-${request.instance.instanceId}`,
          terminalId: `terminal-${request.instance.instanceId}`,
          startedAt: now,
        };
      },
      stop: async () => undefined,
      focus: async () => undefined,
      restart: async (request: { instance: FleetInstance }) => adapter.launch(request),
      resume: async (request: { instance: FleetInstance }) => adapter.launch(request),
      discover: async () => [],
      normalizeEvent: () => undefined,
    };
    const host = {
      hostId: `host-${this.runtime}`,
      hostType: 'test-host',
      launch: adapter.launch,
      stop: adapter.stop,
      focus: adapter.focus,
      sendTask: async (_instanceId: string, task: { workItemId: string }) => {
        this.tasks.push(task.workItemId);
      },
    };
    return { adapter, host };
  }
}

function emptyMetrics(): FleetMetricsSnapshot {
  return {
    capturedAt: now,
    usage: [],
    sessions: [],
    quotas: [],
    totals: {
      durationMs: 0,
      tokens: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
  };
}
