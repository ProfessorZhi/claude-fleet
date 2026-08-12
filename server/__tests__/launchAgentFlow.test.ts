import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn().mockResolvedValue(''),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ name: 'worker-repo', uri: { fsPath: 'C:/work/worker-repo' } }],
  },
}));

vi.mock('vscode', () => vscodeMock);

import {
  type LaunchAgentFlowDeps,
  normalizeProviderSecret,
  runLaunchAgentFlowWithLauncher,
} from '../../adapters/vscode/launchAgentFlow.js';
import type { ProviderProfile } from '../../core/src/providerProfiles.js';

const provider: ProviderProfile = {
  id: 'claude.local',
  name: 'Claude Local',
  kind: 'anthropic-compatible',
  providerType: 'native-anthropic',
  authMode: 'inherit',
  defaultModelId: 'sonnet',
  enabled: true,
};

function makeDeps(overrides: Partial<LaunchAgentFlowDeps> = {}): LaunchAgentFlowDeps {
  return {
    providerProfileStore: {
      list: () => [provider],
      get: () => provider,
      upsert: async () => undefined,
      remove: async () => undefined,
    } as unknown as LaunchAgentFlowDeps['providerProfileStore'],
    secretStorageProvider: {} as LaunchAgentFlowDeps['secretStorageProvider'],
    baseLaunchOptions: {
      providerProfileStore: {} as LaunchAgentFlowDeps['baseLaunchOptions']['providerProfileStore'],
      secretStorageProvider:
        {} as LaunchAgentFlowDeps['baseLaunchOptions']['secretStorageProvider'],
    },
    cliCheck: async () => ({ ok: true, version: 'test', command: 'claude' }),
    ...overrides,
  };
}

describe('New Agent runtime choice', () => {
  it('trims pasted provider secrets and rejects whitespace-only input', () => {
    expect(normalizeProviderSecret('  token-from-console\r\n')).toBe('token-from-console');
    expect(normalizeProviderSecret(' \t\r\n ')).toBeUndefined();
    expect(normalizeProviderSecret(undefined)).toBeUndefined();
  });

  it('launches a Codex Worker through the local CLI without a Fleet secret', async () => {
    const codexLauncher = vi.fn().mockResolvedValue(undefined);
    vscodeMock.window.showQuickPick.mockResolvedValueOnce({
      label: 'Codex CLI',
      value: 'codex-cli',
    });

    await runLaunchAgentFlowWithLauncher(
      makeDeps({
        codexCliCheck: async () => ({
          ok: true,
          command: 'codex.cmd',
          source: 'path',
          searchedPaths: [],
          candidateNames: ['codex.cmd'],
          diagnostics: 'local Codex CLI available',
        }),
        codexLauncher,
      }),
      vi.fn(),
    );

    expect(codexLauncher).toHaveBeenCalledWith({
      cwd: 'C:/work/worker-repo',
      command: 'codex.cmd',
      launchSource: 'fleet-ui',
      requestedBy: 'user',
    });
    expect(codexLauncher.mock.calls[0][0]).not.toHaveProperty('apiKey');
    expect(codexLauncher.mock.calls[0][0]).not.toHaveProperty('secret');
  });

  it('keeps the Claude provider/model flow after explicitly choosing Claude Code', async () => {
    const launcher = vi.fn().mockResolvedValue(undefined);
    vscodeMock.window.showQuickPick
      .mockResolvedValueOnce({ label: 'Claude Code', value: 'claude-code' })
      .mockResolvedValueOnce({ label: provider.name, profile: provider })
      .mockResolvedValueOnce({ label: 'sonnet', value: 'sonnet' });

    await runLaunchAgentFlowWithLauncher(makeDeps({ codexLauncher: vi.fn() }), launcher);

    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({
        launchConfig: {
          cwd: 'C:/work/worker-repo',
          providerProfileId: provider.id,
          modelId: 'sonnet',
        },
        suppressShow: false,
      }),
    );
  });

  it('carries an explicit display name into the launch config', async () => {
    const launcher = vi.fn().mockResolvedValue(undefined);
    vscodeMock.window.showQuickPick
      .mockResolvedValueOnce({ label: 'Claude Code', value: 'claude-code' })
      .mockResolvedValueOnce({ label: provider.name, profile: provider })
      .mockResolvedValueOnce({ label: 'sonnet', value: 'sonnet' });
    vscodeMock.window.showInputBox.mockResolvedValueOnce('minimax1');

    await runLaunchAgentFlowWithLauncher(makeDeps({ codexLauncher: vi.fn() }), launcher);

    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({
        launchConfig: expect.objectContaining({ displayName: 'minimax1' }),
      }),
    );
  });
});
