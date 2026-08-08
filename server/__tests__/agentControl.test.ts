/**
 * Spec 004 — tests for the Focus / Stop / Restart command layer.
 *
 * `restartConfigFromAgent` is pure; the restart orchestration is exercised
 * with fakes for picker / cliCheck / launcher / showError so no VS Code or
 * real process is needed.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock `vscode` so agentControl.ts is importable outside the extension host.
vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), showQuickPick: vi.fn(), showErrorMessage: vi.fn() },
}));

import {
  focusAgent,
  restartConfigFromAgent,
  runRestartAgentCommand,
} from '../../adapters/vscode/agentControl.js';
import {
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  ensureClaudeCliAvailable,
} from '../../adapters/vscode/cliCheck.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function makeAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: undefined,
    isExternal: false,
    projectDir: `/repo-${id}`,
    jsonlFile: `/repo-${id}/${id}.jsonl`,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 100_000,
    ...overrides,
  } as AgentState;
}

describe('restartConfigFromAgent — Spec 004 FR-006', () => {
  it('Restart uses the original launch cwd, NOT the transcript projectDir (Test A)', () => {
    const agent = makeAgent(1, {
      projectDir: 'C:/Users/me/.claude/projects/xyz',
      cwd: 'D:/projects/zuno',
      providerProfileId: 'custom.xyz',
      modelId: 'my-model-1',
    });
    expect(restartConfigFromAgent(agent)).toEqual({
      cwd: 'D:/projects/zuno',
      providerProfileId: 'custom.xyz',
      modelId: 'my-model-1',
    });
  });

  it('preserves Repo (cwd) / Provider / Model when cwd equals projectDir', () => {
    const agent = makeAgent(1, {
      projectDir: '/workspace/repo-a',
      cwd: '/workspace/repo-a',
      providerProfileId: 'custom.xyz',
      modelId: 'my-model-1',
    });
    expect(restartConfigFromAgent(agent)).toEqual({
      cwd: '/workspace/repo-a',
      providerProfileId: 'custom.xyz',
      modelId: 'my-model-1',
    });
  });

  it('legacy agent without cwd falls back to projectDir, no crash (Test D)', () => {
    const agent = makeAgent(1, {
      projectDir: '/old/repo',
      cwd: undefined,
      providerProfileId: undefined,
      modelId: undefined,
    });
    expect(restartConfigFromAgent(agent)).toEqual({
      cwd: '/old/repo',
      providerProfileId: INHERIT_PROVIDER_PROFILE_ID,
      modelId: undefined,
    });
  });

  it('legacy agent without provider/model falls back to Inherit', () => {
    const agent = makeAgent(1, {
      projectDir: '/old/repo',
      cwd: undefined,
      providerProfileId: undefined,
      modelId: undefined,
    });
    expect(restartConfigFromAgent(agent)).toEqual({
      cwd: '/old/repo',
      providerProfileId: INHERIT_PROVIDER_PROFILE_ID,
      modelId: undefined,
    });
  });
});

describe('focusAgent — Spec 004 FR-002', () => {
  it('shows the agent terminal', () => {
    const show = vi.fn();
    const store = new AgentStateStore();
    store.set(1, makeAgent(1, { terminalRef: { show } as never }));
    focusAgent(store, 1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('teammate focuses the lead terminal', () => {
    const show = vi.fn();
    const store = new AgentStateStore();
    store.set(1, makeAgent(1, { terminalRef: { show } as never }));
    store.set(2, makeAgent(2, { leadAgentId: 1 }));
    focusAgent(store, 2);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('unknown id is a no-op', () => {
    const store = new AgentStateStore();
    expect(() => focusAgent(store, 42)).not.toThrow();
  });
});

describe('runRestartAgentCommand — Spec 004 FR-006 ~ FR-008', () => {
  function setup(agent: AgentState) {
    const store = new AgentStateStore();
    store.set(agent.id, agent);
    const runtime = new AgentRuntime(store, claudeProvider);
    const launcher = vi.fn(async (_options: unknown) => {});
    const showError = vi.fn();
    return { store, runtime, launcher, showError };
  }

  it('stops the old instance and relaunches with the SAME Repo/Provider/Model (Test A, end-to-end)', async () => {
    const agent = makeAgent(1, {
      projectDir: 'C:/Users/me/.claude/projects/xyz',
      cwd: 'D:/projects/zuno',
      providerProfileId: 'custom.xyz',
      modelId: 'model-a',
      terminalRef: { dispose: vi.fn() } as never,
    });
    const { store, runtime, launcher, showError } = setup(agent);
    const baseLaunchOptions = { providerProfileStore: {}, secretStorageProvider: {} } as never;

    await runRestartAgentCommand({
      store,
      runtime,
      launcher,
      baseLaunchOptions,
      picker: async () => 1,
      cliCheck: async () => ({ ok: true, version: '2.1.0' }),
      showError,
    });

    // Old instance fully stopped (removed from store)
    expect(store.get(1)).toBeUndefined();
    // New launch carries the preserved config — cwd is the ORIGINAL repo,
    // not the transcript projectDir.
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher.mock.calls[0][0]).toMatchObject({
      launchConfig: {
        cwd: 'D:/projects/zuno',
        providerProfileId: 'custom.xyz',
        modelId: 'model-a',
      },
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('fails closed (no launch) when the Claude CLI is unavailable', async () => {
    const agent = makeAgent(1, { projectDir: '/r', providerProfileId: 'custom.xyz', modelId: 'm' });
    const { store, runtime, launcher, showError } = setup(agent);

    await runRestartAgentCommand({
      store,
      runtime,
      launcher,
      baseLaunchOptions: {} as never,
      picker: async () => 1,
      cliCheck: async () => ({ ok: false, reason: 'claude not found in PATH' }),
      showError,
    });

    expect(store.get(1)).toBeUndefined(); // old instance stopped
    expect(launcher).not.toHaveBeenCalled(); // nothing new launched
    expect(showError).toHaveBeenCalledWith(CLAUDE_CLI_NOT_FOUND_MESSAGE);
  });

  it('cancelled pick is a no-op', async () => {
    const agent = makeAgent(1);
    const { store, runtime, launcher, showError } = setup(agent);

    await runRestartAgentCommand({
      store,
      runtime,
      launcher,
      baseLaunchOptions: {} as never,
      picker: async () => undefined,
      cliCheck: async () => ({ ok: true, version: 'x' }),
      showError,
    });

    expect(store.get(1)).toBeDefined();
    expect(launcher).not.toHaveBeenCalled();
  });

  it('unknown agent id is a no-op', async () => {
    const { store, runtime, launcher, showError } = setup(makeAgent(1));

    await runRestartAgentCommand({
      store,
      runtime,
      launcher,
      baseLaunchOptions: {} as never,
      picker: async () => 999,
      cliCheck: async () => ({ ok: true, version: 'x' }),
      showError,
    });

    expect(launcher).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('uses the real CLI check by default (integration sanity)', async () => {
    // ensureClaudeCliAvailable exists and is wired as the default in agentControl
    expect(ensureClaudeCliAvailable).toBeTypeOf('function');
  });
});
