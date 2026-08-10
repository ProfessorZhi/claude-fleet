import { describe, expect, it, vi } from 'vitest';

import type { LaunchNewTerminalOptions } from '../../adapters/vscode/agentManager.js';
import {
  makeClaudeFleetInstance,
  VscodeFleetRuntimeHost,
  type VscodeRuntimeLaunchRequest,
} from '../../adapters/vscode/fleetRuntimeHost.js';
import type { RuntimeTaskBrief } from '../../core/src/runtimeContracts.js';

function request(overrides: Partial<VscodeRuntimeLaunchRequest> = {}): VscodeRuntimeLaunchRequest {
  return {
    runtime: 'claude-code',
    cwd: 'F:/repo',
    sessionMode: 'new',
    instance: makeClaudeFleetInstance({
      instanceId: 'agent-1',
      cwd: 'F:/repo',
    }),
    launchOptions: {} as LaunchNewTerminalOptions,
    ...overrides,
  };
}

const task: RuntimeTaskBrief = {
  workItemId: 'work-1',
  title: 'Test delivery',
  objective: 'Deliver a bounded brief.',
  acceptanceCriteria: ['Terminal receives the rendered brief.'],
};

describe('VscodeFleetRuntimeHost', () => {
  it('delegates managed Claude launch and returns native identity', async () => {
    const launch = vi.fn(async () => ({
      instanceId: 'agent-1',
      sessionId: 'session-1',
      terminalName: 'Claude Code #1',
      startedAt: 10,
    }));
    const host = new VscodeFleetRuntimeHost({
      launch,
      focus: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    });

    const result = await host.launch(request());

    expect(host.hostId).toBe('vscode-integrated-terminal');
    expect(host.hostType).toBe('vscode-integrated-terminal');
    expect(launch).toHaveBeenCalledOnce();
    expect(result.sessionId).toBe('session-1');
  });

  it('rejects external or non-Claude launch requests before delegation', async () => {
    const launch = vi.fn();
    const host = new VscodeFleetRuntimeHost({
      launch,
      focus: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    });

    await expect(
      host.launch(
        request({
          instance: {
            ...request().instance,
            managedByFleet: false,
          },
        }),
      ),
    ).rejects.toThrow('external');

    await expect(
      host.launch(
        request({
          runtime: 'claude-code',
          instance: {
            ...request().instance,
            runtime: 'codex-cli',
          },
        }),
      ),
    ).rejects.toThrow('Claude Code');

    expect(launch).not.toHaveBeenCalled();
  });

  it('delegates focus and stop to the host-owned callbacks', async () => {
    const focus = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const host = new VscodeFleetRuntimeHost({
      launch: vi.fn(),
      focus,
      stop,
    });

    await host.focus('agent-1');
    await host.stop('agent-1');

    expect(focus).toHaveBeenCalledWith('agent-1');
    expect(stop).toHaveBeenCalledWith('agent-1');
  });

  it('renders a bounded brief before sending it to the injected terminal boundary', async () => {
    const sendText = vi.fn();
    const host = new VscodeFleetRuntimeHost({
      launch: vi.fn(),
      focus: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sendText,
    });

    await host.sendTask?.('agent-1', task);

    expect(sendText).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('[Claude Fleet WorkItem work-1]'),
    );
    expect(sendText.mock.calls[0]?.[1]).not.toContain('rawPrompt');
  });

  it('leaves task delivery unavailable when no terminal boundary is injected', () => {
    const host = new VscodeFleetRuntimeHost({
      launch: vi.fn(),
      focus: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    });

    expect(host.sendTask).toBeUndefined();
  });
});
