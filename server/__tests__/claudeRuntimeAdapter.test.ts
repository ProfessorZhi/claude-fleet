import { describe, expect, it } from 'vitest';

import { ClaudeCodeRuntimeAdapter } from '../../adapters/vscode/claudeRuntimeAdapter.js';
import type { RuntimeLaunchRequest } from '../../core/src/runtimeContracts.js';

function request(overrides: Partial<RuntimeLaunchRequest> = {}): RuntimeLaunchRequest {
  return {
    instance: {
      instanceId: 'claude-1',
      runtime: 'claude-code',
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

describe('ClaudeCodeRuntimeAdapter', () => {
  it('resolves and builds native new/resume launch specs with injected CLI checks', async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\claude',
      npmBinDir: async () => undefined,
      fs: { existsSync: (candidate) => candidate === 'C:\\claude\\claude.cmd' },
      verify: async () => 'claude-test',
    });

    const fresh = await adapter.buildLaunchSpec(
      request({ sessionId: 'session-1', modelId: 'model-a' }),
    );
    const resumed = await adapter.buildLaunchSpec(
      request({ sessionMode: 'resume', sessionId: 'session-1', modelId: 'model-a' }),
    );

    expect(fresh).toMatchObject({ runtime: 'claude-code', cwd: 'C:\\repo', sessionMode: 'new' });
    expect(fresh.args).toContain('--session-id');
    expect(fresh.args).toContain('session-1');
    expect(fresh.args).toContain('--model');
    expect(resumed.args).toEqual(['--resume', 'session-1', '--model', 'model-a']);
  });

  it('does not pretend to own stop/focus when the VS Code host owns lifecycle', async () => {
    const adapter = new ClaudeCodeRuntimeAdapter();
    await expect(adapter.stop('claude-1')).rejects.toThrow(/FleetRuntimeHost/);
    await expect(adapter.focus('claude-1')).rejects.toThrow(/FleetRuntimeHost/);
  });
});
