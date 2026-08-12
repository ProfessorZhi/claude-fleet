import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    createTerminal: vi.fn(),
  },
  env: { shell: 'powershell.exe' },
  workspace: { workspaceFolders: [] },
}));

vi.mock('vscode', () => vscodeMock);

import { launchCodexTerminal } from '../../adapters/vscode/codexAgentManager.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { agentStateToUserStatus } from '../src/agentStatus.js';

describe('Codex VS Code terminal launcher', () => {
  it('creates an isolated managed Worker without an environment secret', () => {
    const terminal = {
      name: 'Codex CLI #1',
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    };
    vscodeMock.window.createTerminal.mockReturnValue(terminal);
    const store = new AgentStateStore();
    const persist = vi.fn();
    const agent = launchCodexTerminal(
      { current: 1 },
      { current: 1 },
      { current: null },
      store,
      persist,
      {
        cwd: 'C:/repo-a',
        command: 'C:/Codex Bin/codex.cmd',
      },
    );

    expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
      name: 'Codex CLI #1',
      cwd: 'C:/repo-a',
    });
    expect(terminal.sendText).toHaveBeenCalledWith('& "C:/Codex Bin/codex.cmd"');
    expect(vscodeMock.window.createTerminal.mock.calls[0][0]).not.toHaveProperty('env');
    expect(agent).toMatchObject({
      id: 1,
      runtime: 'codex-cli',
      cwd: 'C:/repo-a',
      providerId: 'codex-cli',
      managedByFleet: true,
      hooksOnly: true,
      linesProcessed: 0,
    });
    expect(agentStateToUserStatus(agent)).toBe('starting');
    expect(store.get(1)).toBe(agent);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('preserves a coordinator-assigned Fleet instance id on the local agent', () => {
    const terminal = {
      name: 'Codex CLI #7',
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    };
    vscodeMock.window.createTerminal.mockReturnValue(terminal);
    const store = new AgentStateStore();

    const agent = launchCodexTerminal(
      { current: 7 },
      { current: 7 },
      { current: null },
      store,
      vi.fn(),
      {
        cwd: 'C:/repo-a',
        command: 'codex',
        fleetInstanceId: 'zuno-codex-worker-1',
      },
    );

    expect(agent.fleetInstanceId).toBe('zuno-codex-worker-1');
    expect(store.get(7)?.fleetInstanceId).toBe('zuno-codex-worker-1');
  });
});
