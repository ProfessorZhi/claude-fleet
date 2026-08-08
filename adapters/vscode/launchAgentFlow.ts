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
import { validateProviderProfile } from '../../core/src/providerProfiles.js';
import type { ProviderDefinition } from '../../core/src/providerRegistry.js';
import { getVerifiedProviderDefinitions } from '../../core/src/providerRegistry.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';
import {
  claudeCliNotFoundMessage,
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
  // Spec 005 (FR-003): ONLY configured + enabled profiles appear. No
  // auto-injected Inherit / Anthropic Account.
  const profiles = deps.providerProfileStore.list().filter((p) => p.enabled !== false);
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
    void vscode.window.showErrorMessage(claudeCliNotFoundMessage(cli.diagnostics));
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
  if (profiles.length === 0) {
    // Spec 005 (FR-003): no empty QuickPick — surface the empty state with an
    // Add Provider entry.
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: '$(plus) Add Provider…',
          description: 'No Provider Profiles configured yet. Configure one to launch.',
          isAdd: true,
        },
      ],
      { title: 'Claude Fleet: Choose Provider', ignoreFocusOut: true },
    );
    if (!picked?.isAdd) return undefined;
    const created = await runCreateCustomProviderFlow(deps);
    if (!created) return undefined;
    // One-shot re-entry: after adding a provider, immediately let the user pick it.
    return created.enabled === false ? undefined : created;
  }

  const items: Array<vscode.QuickPickItem & { profile?: ProviderProfile; isAdd?: boolean }> =
    profiles.map((p) => ({
      label: p.name,
      description: describeProfile(p),
      detail: p.baseUrl ?? p.presetId ?? undefined,
      profile: p,
    }));
  items.push({
    label: '$(plus) Add Provider…',
    description: 'Configure a new Provider Profile',
    isAdd: true,
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Choose Provider',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.isAdd) {
    const created = await runCreateCustomProviderFlow(deps);
    if (!created) return undefined;
    return created.enabled === false ? undefined : created;
  }
  return picked.profile;
}

function describeProfile(p: ProviderProfile): string {
  const parts: string[] = [];
  switch (p.authMode) {
    case 'inherit':
      parts.push('Native login');
      break;
    case 'apiKey':
      parts.push('API Key');
      break;
    case 'authToken':
      parts.push('Auth Token');
      break;
  }
  if (p.enabled === false) parts.push('disabled');
  return parts.join(' · ');
}

/**
 * Add-a-Provider flow (Spec 005 FR-004): first pick a ProviderDefinition
 * (Official/Native + Anthropic-compatible + Custom), then collect the
 * fields that definition's authStrategy requires. Secrets go to
 * SecretStorage BEFORE the profile is saved (same order as 002).
 *
 * Exported so the Manage Providers command reuses the exact same creation
 * path instead of duplicating it.
 */
export async function runCreateCustomProviderFlow(
  deps: LaunchAgentFlowDeps,
): Promise<ProviderProfile | undefined> {
  const definition = await pickProviderDefinition();
  if (!definition) return undefined;
  if (definition.id === 'custom') {
    return runCustomDefinitionFlow(deps);
  }

  const name = await vscode.window.showInputBox({
    title: `${definition.displayName}: Profile Name`,
    placeHolder: `e.g. ${definition.displayName} - Main`,
    ignoreFocusOut: true,
  });
  if (!name) return undefined;

  // endpoint — prefilled from official definition; user may adjust.
  let endpoint = definition.defaultEndpoint;
  if (definition.providerType === 'anthropic-compatible') {
    const entered = await vscode.window.showInputBox({
      title: `${definition.displayName}: Base URL`,
      placeHolder: definition.defaultEndpoint ?? 'https://api.example.com/anthropic',
      value: definition.defaultEndpoint ?? '',
      ignoreFocusOut: true,
    });
    if (entered === undefined) return undefined;
    endpoint = entered.trim() === '' ? definition.defaultEndpoint : entered.trim();
    if (!endpoint) {
      void vscode.window.showErrorMessage(
        `Claude Fleet: ${definition.displayName} requires a Base URL.`,
      );
      return undefined;
    }
  }

  // auth — per definition authStrategy.
  let authMode: AuthMode = 'inherit';
  let secret: string | undefined;
  let secretLabel = '';
  if (definition.authStrategy === 'api-key') {
    authMode = 'apiKey';
    secretLabel = 'API Key';
  } else if (definition.authStrategy === 'auth-token') {
    authMode = 'authToken';
    secretLabel = 'API Key (sent as Bearer token)';
  }
  if (definition.authStrategy === 'api-key' || definition.authStrategy === 'auth-token') {
    secret = await vscode.window.showInputBox({
      title: `${definition.displayName}: ${secretLabel}`,
      password: true,
      placeHolder: 'paste secret…',
      ignoreFocusOut: true,
    });
    if (!secret) return undefined;
  } else if (definition.authStrategy === 'external-credential-chain') {
    void vscode.window.showInformationMessage(
      `Claude Fleet: "${definition.displayName}" uses your existing ` +
        `system credential chain — no Secret is stored by Claude Fleet.`,
    );
  }

  // default model — official model hints + free input.
  const defaultModelId = await pickDefaultModel(
    definition.displayName,
    definition.supportedModelHints,
  );
  if (defaultModelId === undefined) return undefined;

  const profile: ProviderProfile = {
    id: `${definition.id}.${Date.now().toString(36)}`,
    name,
    kind: 'anthropic-compatible',
    providerType: definition.providerType,
    presetId: definition.id,
    baseUrl: endpoint,
    authMode,
    secretRef:
      authMode === 'inherit'
        ? undefined
        : `claude-fleet.provider.${definition.id}.${Date.now().toString(36)}`,
    modelIds: definition.supportedModelHints?.slice(),
    defaultModelId,
    enabled: true,
  };
  const err = validateProviderProfile(profile);
  if (err) {
    void vscode.window.showErrorMessage(`Claude Fleet: ${err}`);
    return undefined;
  }

  // Save secret FIRST so the secretRef is consistent. If save fails, abort.
  if (profile.secretRef && secret !== undefined) {
    try {
      await deps.secretStorageProvider.set(profile.secretRef, secret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        `Claude Fleet: Failed to store secret: ${msg}. Aborting Provider creation.`,
      );
      return undefined;
    }
  }
  await deps.providerProfileStore.upsert(profile);
  void vscode.window.showInformationMessage(`Claude Fleet: Provider "${name}" saved.`);
  return profile;
}

/** Pick which ProviderDefinition to configure. */
async function pickProviderDefinition(): Promise<ProviderDefinition | undefined> {
  const definitions = getVerifiedProviderDefinitions();
  const official = definitions.filter((d) => d.providerType !== 'anthropic-compatible');
  const compatible = definitions.filter((d) => d.providerType === 'anthropic-compatible');
  const items: Array<
    vscode.QuickPickItem & { definition?: ProviderDefinition; isCustom?: boolean }
  > = [];
  if (official.length > 0) {
    items.push({ label: 'Official / Native', kind: vscode.QuickPickItemKind.Separator });
    for (const d of official) {
      items.push({ label: d.displayName, description: d.description, definition: d });
    }
  }
  if (compatible.length > 0) {
    items.push({
      label: 'Anthropic-compatible',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const d of compatible) {
      items.push({ label: d.displayName, description: d.description, definition: d });
    }
  }
  items.push({
    label: '$(plus) Custom Anthropic-compatible…',
    description: 'Any endpoint / model',
    isCustom: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Add Provider',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.isCustom) {
    return {
      id: 'custom',
      displayName: 'Custom',
      providerType: 'anthropic-compatible',
      runtime: 'claude-code',
      authStrategy: 'auth-token',
      verified: true,
      description: '',
    } satisfies ProviderDefinition;
  }
  return picked.definition;
}

/** Legacy free-form custom provider flow (any endpoint / auth mode / model). */
async function runCustomDefinitionFlow(
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
    placeHolder: 'https://api.example.com/anthropic',
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

  const defaultModelId = await pickDefaultModel('Custom Provider', []);
  if (defaultModelId === undefined) return undefined;

  const profile: ProviderProfile = {
    id: `custom.${Date.now().toString(36)}`,
    name,
    kind: 'anthropic-compatible',
    providerType: 'anthropic-compatible',
    baseUrl,
    authMode,
    secretRef: `claude-fleet.provider.custom.${Date.now().toString(36)}`,
    defaultModelId,
    enabled: true,
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

async function pickDefaultModel(
  title: string,
  hints: string[] | undefined,
): Promise<string | undefined> {
  const presets: Array<vscode.QuickPickItem & { value?: string; isCustom?: boolean }> = [];
  for (const hint of hints ?? []) {
    presets.push({ label: hint, description: 'Suggested model', value: hint });
  }
  presets.push({
    label: '$(edit) Enter model id…',
    description: 'Type any model id',
    isCustom: true,
  });
  const picked = await vscode.window.showQuickPick(presets, {
    title: `${title}: Default Model`,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.isCustom) {
    const entered = await vscode.window.showInputBox({
      title: `${title}: Model id`,
      ignoreFocusOut: true,
    });
    return entered?.trim() || undefined;
  }
  return picked.value;
}

/** Exported for Switch Provider (Spec 005 FR-011) — one model picker for all flows. */
export async function pickModel(provider: ProviderProfile): Promise<string | undefined> {
  // Spec 005: prefer profile.modelIds (configured list), then defaultModelId.
  const candidates = (provider.modelIds ?? []).filter((m) => m.trim() !== '');
  const defaultModel = provider.defaultModelId?.trim() ?? '';
  const presets: Array<vscode.QuickPickItem & { value?: string; isCustom?: boolean }> = [];
  const seen = new Set<string>();
  if (defaultModel && !seen.has(defaultModel)) {
    presets.push({ label: defaultModel, description: 'Provider default', value: defaultModel });
    seen.add(defaultModel);
  }
  for (const m of candidates) {
    if (seen.has(m)) continue;
    presets.push({ label: m, description: 'Configured model', value: m });
    seen.add(m);
  }
  // Common Anthropic aliases — convenience; users on native Anthropic may
  // pick any of them (claude --model accepts aliases like 'opus').
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    if (!seen.has(alias)) {
      presets.push({ label: alias, description: 'Anthropic alias', value: alias });
      seen.add(alias);
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

// Re-export so callers don't have to reach into core for the inherit id
// (legacy restart fallback only — never shown in UI).
export {
  INHERIT_PROVIDER_PROFILE_ID,
  makeInheritProviderProfile,
} from '../../core/src/providerProfiles.js';
