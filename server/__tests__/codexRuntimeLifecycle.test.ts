import { describe, expect, it } from 'vitest';

import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import { FleetControlService } from '../src/fleetControlService.js';
import { CodexFleetRuntimeHost } from '../src/providers/codex/codexFleetRuntimeHost.js';
import {
  type CodexFileSystem,
  CodexRuntimeAdapter,
} from '../src/providers/codex/codexRuntimeAdapter.js';

const codexFileSystem: CodexFileSystem = {
  existsSync: (candidate) => candidate === 'C:\\codex\\codex.cmd',
};

class FakeClaudeAdapter implements RuntimeAdapter {
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

  async detect(): Promise<boolean> {
    return true;
  }

  async getVersion(): Promise<string> {
    return 'fake-claude';
  }

  async buildLaunchSpec(request: RuntimeLaunchRequest): Promise<unknown> {
    return { runtime: request.instance.runtime, cwd: request.cwd };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return {
      instanceId: request.instance.instanceId,
      sessionId: request.sessionId ?? request.instance.sessionId,
      startedAt: 20,
    };
  }

  async stop(_instanceId: string): Promise<void> {}

  async focus(_instanceId: string): Promise<void> {}

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

class RecordingHost implements FleetRuntimeHost {
  readonly hostId = 'fake-claude-host';
  readonly hostType = 'fake-claude-host';
  readonly calls: string[] = [];

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.calls.push('launch:' + request.instance.instanceId + ':' + request.sessionMode);
    return {
      instanceId: request.instance.instanceId,
      sessionId: request.sessionId ?? request.instance.sessionId,
      startedAt: 20,
    };
  }

  async stop(instanceId: string): Promise<void> {
    this.calls.push('stop:' + instanceId);
  }

  async focus(instanceId: string): Promise<void> {
    this.calls.push('focus:' + instanceId);
  }
}

function instance(
  instanceId: string,
  runtime: FleetInstance['runtime'],
  status: FleetInstance['status'],
): FleetInstance {
  return {
    instanceId,
    runtime,
    role: 'worker',
    managedByFleet: true,
    status,
    sessionId: instanceId + '-session',
    workspaceId: 'C:\\repo',
    repo: 'C:\\repo',
    createdAt: 1,
  };
}

function command(
  requestId: string,
  action: 'focus_instance' | 'stop_instance' | 'resume_instance',
  instanceId: string,
) {
  return {
    requestId,
    action,
    mode: 'approve' as const,
    requestedBy: 'mixed-runtime-test',
    instanceId,
    createdAt: 2,
  };
}

describe('mixed Claude and Codex runtime lifecycle', () => {
  it('routes management commands to the selected runtime host only', async () => {
    const codexCalls: string[] = [];
    const codexAdapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: codexFileSystem,
      verify: async () => 'codex-test',
      launch: async (request) => {
        codexCalls.push('launch:' + request.instance.instanceId + ':' + request.sessionMode);
        return {
          instanceId: request.instance.instanceId,
          sessionId: request.sessionId ?? request.instance.sessionId,
          startedAt: 30,
        };
      },
    });
    const codexHost = new CodexFleetRuntimeHost(codexAdapter, {
      stop: async (instanceId) => {
        codexCalls.push('stop:' + instanceId);
      },
      focus: async (instanceId) => {
        codexCalls.push('focus:' + instanceId);
      },
    });
    const claudeHost = new RecordingHost();
    const service = new FleetControlService({
      now: () => 100,
      instances: [
        instance('codex-1', 'codex-cli', 'waiting'),
        instance('claude-1', 'claude-code', 'waiting'),
      ],
      registrations: [
        { adapter: codexAdapter, host: codexHost },
        { adapter: new FakeClaudeAdapter(), host: claudeHost },
      ],
    });

    expect(codexAdapter.capabilities).toMatchObject({
      stop: true,
      focus: true,
      restart: true,
      resume: true,
      discover: false,
    });

    await expect(
      service.submit(command('focus-codex', 'focus_instance', 'codex-1')),
    ).resolves.toMatchObject({
      decision: 'accepted',
    });
    await expect(
      service.submit(command('focus-claude', 'focus_instance', 'claude-1')),
    ).resolves.toMatchObject({
      decision: 'accepted',
    });
    await expect(
      service.submit(command('stop-codex', 'stop_instance', 'codex-1')),
    ).resolves.toMatchObject({
      decision: 'accepted',
      instance: { instanceId: 'codex-1', status: 'stopped' },
    });
    await expect(
      service.submit(command('resume-codex', 'resume_instance', 'codex-1')),
    ).resolves.toMatchObject({
      decision: 'accepted',
      instance: { instanceId: 'codex-1', status: 'starting' },
    });

    expect(codexCalls).toEqual(['focus:codex-1', 'stop:codex-1', 'launch:codex-1:resume']);
    expect(claudeHost.calls).toEqual(['focus:claude-1']);
  });
});
