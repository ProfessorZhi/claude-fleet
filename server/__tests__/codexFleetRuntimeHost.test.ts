import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
} from '../../core/src/runtimeContracts.js';
import {
  CodexFleetRuntimeHost,
  type CodexFleetRuntimeHostDependencies,
} from '../src/providers/codex/codexFleetRuntimeHost.js';
import {
  type CodexFileSystem,
  CodexRuntimeAdapter,
} from '../src/providers/codex/codexRuntimeAdapter.js';

const fileSystem: CodexFileSystem = {
  existsSync: (candidate) => candidate === 'C:\\codex\\codex.cmd',
};

function request(overrides: Partial<RuntimeLaunchRequest> = {}): RuntimeLaunchRequest {
  return {
    instance: {
      instanceId: 'codex-1',
      runtime: 'codex-cli',
      role: 'worker',
      managedByFleet: true,
      status: 'starting',
      createdAt: 1,
    },
    cwd: 'C:\\repo',
    sessionMode: 'new',
    ...overrides,
  };
}

function dependencies(calls: string[]): CodexFleetRuntimeHostDependencies {
  return {
    stop: async (instanceId) => {
      calls.push('stop:' + instanceId);
    },
    focus: async (instanceId) => {
      calls.push('focus:' + instanceId);
    },
  };
}

const task: RuntimeTaskBrief = {
  workItemId: 'work-codex-1',
  title: 'Test Codex delivery',
  objective: 'Deliver a bounded task brief to Codex.',
  acceptanceCriteria: ['The injected terminal receives only the rendered brief.'],
};

describe('CodexFleetRuntimeHost', () => {
  it('enforces ownership and delegates launch to the native adapter', async () => {
    const calls: string[] = [];
    let launchRequest: RuntimeLaunchRequest | undefined;
    const result: RuntimeLaunchResult = { instanceId: 'codex-1', startedAt: 2 };
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async (requestValue) => {
        launchRequest = requestValue;
        return result;
      },
    });
    const host = new CodexFleetRuntimeHost(adapter, dependencies(calls));

    await expect(host.launch(request())).resolves.toEqual(result);
    expect(launchRequest?.instance.instanceId).toBe('codex-1');

    await host.focus('codex-1');
    await host.stop('codex-1');
    expect(calls).toEqual(['focus:codex-1', 'stop:codex-1']);
  });

  it('rejects external or non-Codex launch requests before adapter execution', async () => {
    let launched = false;
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async () => {
        launched = true;
        return { instanceId: 'codex-1', startedAt: 2 };
      },
    });
    const host = new CodexFleetRuntimeHost(adapter, dependencies([]));

    await expect(
      host.launch(
        request({
          instance: { ...request().instance, managedByFleet: false },
        }),
      ),
    ).rejects.toThrow(/external/);
    expect(launched).toBe(false);
  });

  it('exposes restart and resume through the injected terminal boundary', async () => {
    const calls: string[] = [];
    const launches: RuntimeLaunchRequest[] = [];
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async (launchRequest) => {
        launches.push(launchRequest);
        return { instanceId: 'codex-1', sessionId: 'session-1', startedAt: 3 };
      },
    });
    const host = new CodexFleetRuntimeHost(adapter, {
      ...dependencies(calls),
      discover: async () => [{ instanceId: 'codex-1', runtime: 'codex-cli' }],
    });

    expect(adapter.capabilities).toMatchObject({
      stop: true,
      focus: true,
      restart: true,
      resume: true,
      discover: true,
    });
    await expect(host.restart(request({ sessionId: 'session-1' }))).resolves.toMatchObject({
      instanceId: 'codex-1',
    });
    await expect(host.resume(request({ sessionId: 'session-1' }))).resolves.toMatchObject({
      instanceId: 'codex-1',
    });
    await expect(host.discover?.()).resolves.toEqual([
      { instanceId: 'codex-1', runtime: 'codex-cli' },
    ]);
    expect(calls).toEqual(['stop:codex-1']);
    expect(launches).toHaveLength(2);
    expect(launches.map((value) => [value.sessionMode, value.sessionId])).toEqual([
      ['resume', 'session-1'],
      ['resume', 'session-1'],
    ]);
  });

  it('fails closed for resume and restart without a session identity', async () => {
    const calls: string[] = [];
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async () => ({ instanceId: 'codex-1', startedAt: 3 }),
    });
    const host = new CodexFleetRuntimeHost(adapter, dependencies(calls));

    await expect(host.resume(request())).rejects.toThrow(/sessionId/);
    await expect(host.restart(request())).rejects.toThrow(/sessionId/);
    expect(calls).toEqual([]);
  });

  it('renders a bounded brief before sending it to the injected Codex terminal', async () => {
    const sendText = vi.fn();
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async () => ({ instanceId: 'codex-1', startedAt: 3 }),
    });
    const host = new CodexFleetRuntimeHost(adapter, {
      ...dependencies([]),
      sendText,
    });

    await host.sendTask?.('codex-1', task);

    expect(sendText).toHaveBeenCalledWith(
      'codex-1',
      expect.stringContaining('[Claude Fleet WorkItem work-codex-1]'),
    );
    expect(sendText.mock.calls[0]?.[1]).not.toContain('rawPrompt');
  });

  it('keeps task delivery unavailable without an injected Codex terminal boundary', () => {
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      fs: fileSystem,
      verify: async () => 'codex-test',
      launch: async () => ({ instanceId: 'codex-1', startedAt: 3 }),
    });
    const host = new CodexFleetRuntimeHost(adapter, dependencies([]));

    expect(host.sendTask).toBeUndefined();
  });
});
