/**
 * LaunchAgentFlow — Spec 002 T009.
 *
 * Implements the `+ Agent` QuickPick / InputBox flow that lets the user
 * choose Repo / Provider / Model before a Claude Code terminal is spawned.
 *
 * Flow:
 *   1. Pick Repo (QuickPick over workspace folders; auto-pick if only one)
 *   2. Pick Provider (QuickPick over existing Profiles + "Create Custom…")
 *   3. Pick Model (QuickPick over known models + "Enter model id…")
 *   4. Launch via `launchNewTerminal`
 *
 * The "Create Custom Provider" sub-flow collects name / baseUrl / authMode /
 * secret / defaultModelId and persists them via ProviderProfileStore +
 * SecretStorageProvider.
 *
 * See:
 *   docs/specs/002-provider-model-isolation/design.md § T009
 */

import * as vscode from 'vscode';

import type { AuthMode, ProviderProfile } from '../../core/src/providerProfiles.js';
import {
  INHERIT_PROVIDER_PROFILE_ID,
  makeInheritProviderProfile,
  validateProviderProfile,
} from '../../core/src/providerProfiles.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';
import {
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  type CliCheckResult,
  ensureClaudeCliAvailable,
} from './cliCheck.js';
import type { ProviderProfileStore } from './providerProfileStore.js';
import {
  createSecretStorageProvider,
  type SecretStorageProvider,
} from './secretStorageProvider.js';

export interface LaunchAgentFlowDeps {
  providerProfileStore: ProviderProfileStore;
  secretStorageProvider: SecretStorageProvider;
  /** Runtime args for launchNewTerminal, excluding the fields this flow fills. */
  baseLaunchOptions: Omit<LaunchNewTerminalOptions, 'launchConfig' | 'suppressShow'>;
  /** CLI availability check (Spec 004 FR-014); injectable for tests. */
  cliCheck?: () => Promise<CliCheckResult>;
}

/**
 * High-level launcher used by extension.ts. The `launcher` callback receives
 * the resolved `LaunchNewTerminalOptions` and is responsible for invoking
 * `launchNewTerminal` with the runtime-specific args (AgentStateStore,
 * timers, etc.) that the view provider owns.
 */
export async function runLaunchAgentFlowWithLauncher(
  deps: LaunchAgentFlowDeps,
  launcher: (options: LaunchNewTerminalOptions) => Promise<void>,
): Promise<void> {
  // ── Step 1: Repo ──────────────────────────────────────────
  const cwd = await pickRepo();
  if (cwd === undefined) return;

  // ── Step 2: Provider ──────────────────────────────────────
  const profiles = deps.providerProfileStore.list();
  const provider = await pickProvider(profiles, deps);
  if (provider === undefined) return;

  // ── Step 3: Model ─────────────────────────────────────────
  const modelId = await pickModel(provider);
  if (modelId === undefined) return;

  // ── Step 4: CLI availability (Spec 004 FR-014) ────────────
  // Check ONCE per launch, before any terminal exists. A missing `claude`
  // would otherwise create a terminal that immediately fails. The check is
  // injectable (tests) and never runs on a timer.
  const cliCheck = deps.cliCheck ?? ensureClaudeCliAvailable;
  const cli = await cliCheck();
  if (!cli.ok) {
    console.warn(`[Claude Fleet] Launch aborted: ${cli.reason}`);
    void vscode.window.showErrorMessage(CLAUDE_CLI_NOT_FOUND_MESSAGE);
    return;
  }

  // ── Step 5: Launch ────────────────────────────────────────
  await launcher({
    ...deps.baseLaunchOptions,
    launchConfig: { cwd, providerProfileId: provider.id, modelId },
    suppressShow: false,
  });
}

// ── Helpers ────────────────────────────────────────────────

async function pickRepo(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(
      'Claude Fleet: No workspace folder open. Opening Claude Code in the home directory.',
    );
    // Empty cwd signals to launchNewTerminal to fall back to homedir.
    return '';
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
    { title: 'Claude Fleet: Choose workspace folder', ignoreFocusOut: true },
  );
  return picked?.fsPath;
}

async function pickProvider(
  profiles: ProviderProfile[],
  deps: LaunchAgentFlowDeps,
): Promise<ProviderProfile | undefined> {
  const items: Array<vscode.QuickPickItem & { profile?: ProviderProfile; isCreate?: boolean }> =
    profiles.map((p) => ({
      label: p.name,
      description: describeProfile(p),
      detail:
        p.authMode === 'inherit' ? 'Built-in (uses your existing Claude Code login)' : p.baseUrl,
      profile: p,
    }));
  items.push({
    label: '$(plus) Create Custom Provider…',
    description: 'Configure a custom Anthropic-compatible endpoint',
    isCreate: true,
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Choose Provider',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.isCreate) {
    return await runCreateCustomProviderFlow(deps);
  }
  return picked.profile;
}

function describeProfile(p: ProviderProfile): string {
  switch (p.authMode) {
    case 'inherit':
      return 'Inherit (no override)';
    case 'apiKey':
      return 'API Key';
    case 'authToken':
      return 'Auth Token';
  }
}

/**
 * Create-a-Custom-Provider sub-flow (InputBoxes + SecretStorage write).
 * Exported so the Manage Providers command (Spec 004) reuses the exact same
 * creation path instead of duplicating it.
 */
export async function runCreateCustomProviderFlow(
  deps: LaunchAgentFlowDeps,
): Promise<ProviderProfile | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Custom Provider: Name',
    placeHolder: 'e.g. My Gateway',
    ignoreFocusOut: true,
  });
  if (!name) return undefined;

  const baseUrl = await vscode.window.showInputBox({
    title: 'Custom Provider: Base URL',
    placeHolder: 'https://api.example.com',
    ignoreFocusOut: true,
  });
  if (!baseUrl) return undefined;
  try {
    new URL(baseUrl);
  } catch {
    void vscode.window.showErrorMessage(`Claude Fleet: Base URL "${baseUrl}" is not a valid URL.`);
    return undefined;
  }

  const authModePick = await vscode.window.showQuickPick(
    [
      {
        label: 'API Key',
        description: 'Sends as `X-Api-Key` header (ANTHROPIC_API_KEY)',
        value: 'apiKey' as AuthMode,
      },
      {
        label: 'Auth Token',
        description: 'Sends as `Authorization: Bearer …` (ANTHROPIC_AUTH_TOKEN)',
        value: 'authToken' as AuthMode,
      },
    ],
    { title: 'Custom Provider: Auth Mode', ignoreFocusOut: true },
  );
  if (!authModePick) return undefined;
  const authMode: AuthMode = authModePick.value;

  const secret = await vscode.window.showInputBox({
    title: `Custom Provider: ${authModePick.label}`,
    password: true,
    placeHolder: 'paste secret…',
    ignoreFocusOut: true,
  });
  if (!secret) return undefined;

  const defaultModelId = await vscode.window.showInputBox({
    title: 'Custom Provider: Default Model ID',
    placeHolder: 'e.g. my-custom-model',
    ignoreFocusOut: true,
  });
  if (!defaultModelId) {
    void vscode.window.showErrorMessage(
      'Claude Fleet: Custom Provider requires a default Model ID.',
    );
    return undefined;
  }

  const profile: ProviderProfile = {
    id: `custom.${Date.now().toString(36)}`,
    name,
    kind: 'anthropic-compatible',
    baseUrl,
    authMode,
    secretRef: `claude-fleet.provider.custom.${Date.now().toString(36)}`,
    defaultModelId,
  };
  const err = validateProviderProfile(profile);
  if (err) {
    void vscode.window.showErrorMessage(`Claude Fleet: ${err}`);
    return undefined;
  }

  // Save secret FIRST so the secretRef is consistent. If save fails, abort.
  try {
    await deps.secretStorageProvider.set(profile.secretRef!, secret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(
      `Claude Fleet: Failed to store secret: ${msg}. Aborting Provider creation.`,
    );
    return undefined;
  }
  await deps.providerProfileStore.upsert(profile);
  void vscode.window.showInformationMessage(`Claude Fleet: Provider "${name}" saved.`);
  return profile;
}

async function pickModel(provider: ProviderProfile): Promise<string | undefined> {
  const defaultModel = provider.defaultModelId?.trim() ?? '';
  const presets: Array<vscode.QuickPickItem & { value?: string; isCustom?: boolean }> = [];
  if (defaultModel) {
    presets.push({ label: defaultModel, description: 'Provider default', value: defaultModel });
  }
  // Common Anthropic aliases — shown for convenience; user can pick any of them.
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    if (alias !== defaultModel) {
      presets.push({ label: alias, description: 'Anthropic alias', value: alias });
    }
  }
  presets.push({
    label: '$(edit) Enter model id…',
    description: 'Type any model id (Anthropic-compatible gateway may use custom ids)',
    isCustom: true,
  });

  const picked = await vscode.window.showQuickPick(presets, {
    title: 'Claude Fleet: Choose Model',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.isCustom) {
    const entered = await vscode.window.showInputBox({
      title: 'Claude Fleet: Model id',
      placeHolder: 'e.g. claude-opus-4 / claude-sonnet-5 / my-custom-model',
      ignoreFocusOut: true,
    });
    return entered?.trim() || undefined;
  }
  return picked.value;
}

/** Convenience used by extension.ts to construct deps from ExtensionContext. */
export function createLaunchAgentFlowDepsFromContext(
  context: vscode.ExtensionContext,
  providerProfileStore: ProviderProfileStore,
  baseLaunchOptions: LaunchAgentFlowDeps['baseLaunchOptions'],
): LaunchAgentFlowDeps {
  const secretStorageProvider: SecretStorageProvider = createSecretStorageProvider(context);
  return { providerProfileStore, secretStorageProvider, baseLaunchOptions };
}

// Re-export so callers don't have to reach into core for the inherit id.
export { INHERIT_PROVIDER_PROFILE_ID, makeInheritProviderProfile };
