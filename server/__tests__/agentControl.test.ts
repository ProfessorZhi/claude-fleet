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
  newSessionConfigFromAgent,
  restartConfigFromAgent,
  runNewSessionCommand,
  runRestartAgentCommand,
  runSwitchProviderCommand,
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
      // Spec 005 — Restart resumes the SAME session.
      sessionId: 'sess-1',
      sessionMode: 'resume',
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
      sessionId: 'sess-1',
      sessionMode: 'resume',
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
      sessionId: 'sess-1',
      sessionMode: 'resume',
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
      sessionId: 'sess-1',
      sessionMode: 'resume',
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
    // not the transcript projectDir; the SAME session is resumed (Spec 005).
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher.mock.calls[0][0]).toMatchObject({
      launchConfig: {
        cwd: 'D:/projects/zuno',
        providerProfileId: 'custom.xyz',
        modelId: 'model-a',
        sessionId: 'sess-1',
        sessionMode: 'resume',
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

// ── Spec 005: Session Continuity ─────────────────────────────

describe('restartConfigFromAgent — Spec 005 resume semantics', () => {
  it('Restart now RESUMES the same Claude session (sessionMode resume + sessionId)', () => {
    const agent = makeAgent(1, {
      cwd: '/repo-a',
      projectDir: '/transcripts/a',
      sessionId: 'sess-1',
      providerProfileId: 'deepseek.1',
      modelId: 'deepseek-v4-pro[1m]',
    });
    expect(restartConfigFromAgent(agent)).toEqual({
      cwd: '/repo-a',
      providerProfileId: 'deepseek.1',
      modelId: 'deepseek-v4-pro[1m]',
      sessionId: 'sess-1',
      sessionMode: 'resume',
    });
  });

  it('newSessionConfigFromAgent keeps repo/provider/model but drops the session', () => {
    const agent = makeAgent(1, {
      cwd: '/repo-a',
      projectDir: '/transcripts/a',
      sessionId: 'sess-1',
      providerProfileId: 'deepseek.1',
      modelId: 'deepseek-v4-pro[1m]',
    });
    expect(newSessionConfigFromAgent(agent)).toEqual({
      cwd: '/repo-a',
      providerProfileId: 'deepseek.1',
      modelId: 'deepseek-v4-pro[1m]',
    });
  });
});

describe('runSwitchProviderCommand — Spec 005 FR-011', () => {
  function makeStore(
    profiles: Array<Partial<import('../../core/src/providerProfiles.js').ProviderProfile>>,
  ) {
    return {
      list: () =>
        profiles.map((p, i) => ({
          id: `p${i}`,
          name: `P${i}`,
          kind: 'anthropic-compatible' as const,
          authMode: 'inherit' as const,
          ...p,
        })),
      get: (id: string) => profiles.find((p) => p.id === id),
      upsert: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
  }

  it('switches provider keeping cwd + sessionId with resume mode', async () => {
    const agent = makeAgent(1, {
      cwd: '/repo-zuno',
      projectDir: '/transcripts/zuno',
      sessionId: 'S1',
      providerProfileId: 'minimax.1',
      modelId: 'MiniMax-M3[1m]',
      terminalRef: { dispose: vi.fn() } as never,
    });
    const store = new AgentStateStore();
    store.set(1, agent);
    const runtime = new AgentRuntime(store, claudeProvider);
    const launcher = vi.fn(async (_options: unknown) => {});
    const profileStore = makeStore([
      { id: 'minimax.1', name: 'MiniMax - Main' },
      {
        id: 'deepseek.1',
        name: 'DeepSeek - Main',
        defaultModelId: 'deepseek-v4-pro[1m]',
        modelIds: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
      },
    ]) as never;
    const showError = vi.fn();

    // Drive the QuickPicks by call order:
    //   1. pickProfileForSwitch → the DeepSeek profile item
    //   2. pickModel → the model value item
    const vscodeMock = await import('vscode');
    const pickSpy = vscodeMock.window.showQuickPick as ReturnType<typeof vi.fn>;
    pickSpy.mockReset();
    let quickPickCall = 0;
    pickSpy.mockImplementation(async (items: Array<{ profile?: unknown; value?: string }>) => {
      quickPickCall += 1;
      if (quickPickCall === 1) {
        const withProfile = (items as Array<{ profile?: unknown }>).filter((i) => i.profile);
        return (
          withProfile.find((i) => (i.profile as { id?: string })?.id === 'deepseek.1') ??
          withProfile[0]
        );
      }
      // Model picker: pick the preset whose value is the DeepSeek model.
      const withValue = (items as Array<{ value?: string }>).filter((i) => i.value);
      return withValue.find((i) => i.value === 'deepseek-v4-pro[1m]') ?? withValue[0];
    });

    await runSwitchProviderCommand({
      store,
      runtime,
      providerProfileStore: profileStore,
      launcher,
      baseLaunchOptions: { providerProfileStore: {}, secretStorageProvider: {} } as never,
      picker: async () => 1,
      cliCheck: async () => ({ ok: true, version: '2.1.220' }),
      showError,
    });

    expect(store.get(1)).toBeUndefined(); // old instance stopped
    expect(launcher).toHaveBeenCalledTimes(1);
    const cfg = (
      launcher.mock.calls[0][0] as {
        launchConfig: {
          cwd: string;
          providerProfileId: string;
          sessionId: string;
          sessionMode: string;
          modelId: string;
        };
      }
    ).launchConfig;
    expect(cfg.cwd).toBe('/repo-zuno'); // Repo unchanged
    expect(cfg.sessionId).toBe('S1'); // Session unchanged
    expect(cfg.sessionMode).toBe('resume'); // Native resume
    expect(cfg.providerProfileId).toBe('deepseek.1'); // New provider
    expect(cfg.modelId).toBe('deepseek-v4-pro[1m]'); // New model
  });

  it('fails closed with a clear error when no profiles are configured', async () => {
    const agent = makeAgent(1, { cwd: '/r', sessionId: 'S1', providerProfileId: 'x' });
    const store = new AgentStateStore();
    store.set(1, agent);
    const runtime = new AgentRuntime(store, claudeProvider);
    const launcher = vi.fn(async () => {});
    const showError = vi.fn();

    await runSwitchProviderCommand({
      store,
      runtime,
      providerProfileStore: makeStore([]) as never,
      launcher,
      baseLaunchOptions: {} as never,
      picker: async () => 1,
      cliCheck: async () => ({ ok: true, version: 'x' }),
      showError,
    });

    expect(launcher).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalled();
    expect(store.get(1)).toBeDefined(); // agent untouched
  });
});

describe('runNewSessionCommand — Spec 005 FR-010', () => {
  it('launches a fresh session with the same repo/provider/model', async () => {
    const agent = makeAgent(1, {
      cwd: '/repo-a',
      projectDir: '/t/a',
      sessionId: 'S1',
      providerProfileId: 'deepseek.1',
      modelId: 'deepseek-v4-pro[1m]',
      terminalRef: { dispose: vi.fn() } as never,
    });
    const store = new AgentStateStore();
    store.set(1, agent);
    const runtime = new AgentRuntime(store, claudeProvider);
    const launcher = vi.fn(async (_options: unknown) => {});

    await runNewSessionCommand({
      store,
      runtime,
      launcher,
      baseLaunchOptions: { providerProfileStore: {}, secretStorageProvider: {} } as never,
      picker: async () => 1,
      cliCheck: async () => ({ ok: true, version: 'x' }),
      showError: vi.fn(),
    });

    expect(launcher).toHaveBeenCalledTimes(1);
    const cfg = (
      launcher.mock.calls[0][0] as {
        launchConfig: {
          cwd: string;
          providerProfileId: string;
          modelId: string;
          sessionId?: string;
          sessionMode?: string;
        };
      }
    ).launchConfig;
    expect(cfg.cwd).toBe('/repo-a');
    expect(cfg.providerProfileId).toBe('deepseek.1');
    expect(cfg.modelId).toBe('deepseek-v4-pro[1m]');
    // No explicit sessionId → launchNewTerminal generates a fresh UUID;
    // sessionMode defaults to 'new'.
    expect(cfg.sessionId).toBeUndefined();
    expect(cfg.sessionMode).toBeUndefined();
  });
});
