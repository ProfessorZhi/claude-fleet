import { describe, expect, it } from 'vitest';

import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '../../core/src/runtimeContracts.js';
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
});
