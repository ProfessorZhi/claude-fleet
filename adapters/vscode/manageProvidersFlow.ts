/**
 * manageProvidersFlow — Spec 004 / Spec 005 Manage Providers command.
 *
 * QuickPick-based management: list configured profiles (Display Name / Type /
 * Endpoint(safe) / Auth Strategy / Default Model / Status — NEVER the
 * secret), Add Provider (via the definition-based creation flow), Edit
 * (rename / endpoint / model list / replace secret / enable-disable), and
 * Delete (profile + SecretStorage secret — no orphan secrets, FR-010).
 *
 * The deletion core (`deleteProviderProfile`) is separated from the vscode
 * UI so it is unit-testable with fakes.
 */

import * as vscode from 'vscode';

import type { AuthMode, ProviderProfile } from '../../core/src/providerProfiles.js';
import {
  INHERIT_PROVIDER_PROFILE_ID,
  validateProviderProfile,
} from '../../core/src/providerProfiles.js';
import { getProviderDefinition } from '../../core/src/providerRegistry.js';
import {
  type LaunchAgentFlowDeps,
  normalizeProviderSecret,
  runCreateCustomProviderFlow,
} from './launchAgentFlow.js';
import type { ProviderProfileStore } from './providerProfileStore.js';
import type { SecretStorageProvider } from './secretStorageProvider.js';

/**
 * Delete a custom provider profile AND its secret (Spec 004 FR-010).
 *
 * Order matters: delete the secret FIRST. If the secret delete fails, abort
 * WITHOUT removing the profile — the store and the secret stay consistent
 * (no half-deleted state). The built-in Inherit profile can never be deleted.
 *
 * Returns an error string on failure, or undefined on success.
 */
export async function deleteProviderProfile(
  store: ProviderProfileStore,
  secrets: SecretStorageProvider,
  profile: ProviderProfile,
): Promise<string | undefined> {
  if (profile.id === INHERIT_PROVIDER_PROFILE_ID) {
    return `Claude Fleet: The built-in "${profile.name}" profile cannot be deleted.`;
  }
  if (profile.secretRef) {
    try {
      await secrets.delete(profile.secretRef);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Claude Fleet: Failed to delete the secret for "${profile.name}": ${msg}. Profile NOT deleted.`;
    }
  }
  await store.remove(profile.id);
  return undefined;
}

function describeProfile(p: ProviderProfile): string {
  const def = p.presetId ? getProviderDefinition(p.presetId) : undefined;
  const type = def?.displayName ?? p.providerType ?? 'Custom';
  const parts = [type];
  if (p.enabled === false) parts.push('disabled');
  return parts.join(' · ');
}

function detailProfile(p: ProviderProfile): string {
  const parts: string[] = [];
  if (p.baseUrl) parts.push(p.baseUrl);
  parts.push(
    p.authMode === 'inherit' ? 'native login' : p.authMode === 'apiKey' ? 'API Key' : 'Auth Token',
  );
  if (p.defaultModelId) parts.push(`default: ${p.defaultModelId}`);
  return parts.join(' · ');
}

/**
 * Run the Manage Providers QuickPick flow (Spec 004 FR-009 / Spec 005 FR-004):
 *
 *   - "<profile>"  → Edit / Delete / Cancel actions
 *   - "$(plus) Add Provider…" → definition-based creation flow
 */
export async function runManageProvidersFlow(deps: LaunchAgentFlowDeps): Promise<void> {
  const profiles = deps.providerProfileStore.list();

  const items: Array<vscode.QuickPickItem & { profile?: ProviderProfile; isAdd?: boolean }> =
    profiles.map((p) => ({
      label: p.name,
      description: describeProfile(p),
      detail: detailProfile(p),
      profile: p,
    }));
  items.push({
    label: '$(plus) Add Provider…',
    description: 'Configure a new Provider Profile',
    isAdd: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Manage Providers',
    ignoreFocusOut: true,
  });
  if (!picked) return;

  if (picked.isAdd) {
    await runCreateCustomProviderFlow(deps);
    return;
  }

  const profile = picked.profile!;
  if (profile.id === INHERIT_PROVIDER_PROFILE_ID) {
    void vscode.window.showInformationMessage(
      'Claude Fleet: The built-in Inherit profile is always available and cannot be deleted.',
    );
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Edit', description: `Edit "${profile.name}"`, value: 'edit' },
      {
        label: '$(trash) Delete',
        description: `Permanently delete "${profile.name}" and its saved secret`,
        value: 'delete',
      },
      { label: 'Cancel', value: 'cancel' },
    ],
    { title: `Claude Fleet: Manage "${profile.name}"`, ignoreFocusOut: true },
  );
  if (!action || action.value === 'cancel') return;

  if (action.value === 'edit') {
    const updated = await runEditProviderFlow(deps, profile);
    if (updated) {
      void vscode.window.showInformationMessage(
        `Claude Fleet: Provider "${updated.name}" updated.`,
      );
    }
    return;
  }

  const err = await deleteProviderProfile(
    deps.providerProfileStore,
    deps.secretStorageProvider,
    profile,
  );
  if (err) {
    void vscode.window.showErrorMessage(err);
    return;
  }
  void vscode.window.showInformationMessage(`Claude Fleet: Provider "${profile.name}" deleted.`);
}

/**
 * Edit a Provider Profile (Spec 005 FR-047): rename / endpoint / model list /
 * replace-or-delete secret / enable-disable. The secret is NEVER read back
 * and displayed — only Leave unchanged | Replace | Delete.
 */
export async function runEditProviderFlow(
  deps: LaunchAgentFlowDeps,
  profile: ProviderProfile,
): Promise<ProviderProfile | undefined> {
  const updated: ProviderProfile = { ...profile };

  // 1. Rename
  const name = await vscode.window.showInputBox({
    title: 'Edit Provider: Name',
    value: profile.name,
    ignoreFocusOut: true,
  });
  if (name === undefined) return undefined;
  if (name.trim() !== '') updated.name = name.trim();

  // 2. Endpoint (only for endpoint-driven types)
  if (updated.providerType === 'anthropic-compatible' || profile.baseUrl) {
    const endpoint = await vscode.window.showInputBox({
      title: 'Edit Provider: Base URL',
      value: profile.baseUrl ?? '',
      placeHolder: 'https://api.example.com/anthropic',
      ignoreFocusOut: true,
    });
    if (endpoint === undefined) return undefined;
    if (endpoint.trim() !== '') {
      try {
        new URL(endpoint.trim());
      } catch {
        void vscode.window.showErrorMessage(
          `Claude Fleet: Base URL "${endpoint}" is not a valid URL.`,
        );
        return undefined;
      }
      updated.baseUrl = endpoint.trim();
    } else {
      updated.baseUrl = undefined;
    }
  }

  // 3. Secret — Leave unchanged | Replace | Delete (never display the value)
  let secretAction: 'unchanged' | 'replace' | 'delete' = 'unchanged';
  if (profile.authMode !== 'inherit') {
    const action = await vscode.window.showQuickPick(
      [
        {
          label: 'Leave unchanged',
          description: 'Keep the current saved secret',
          value: 'unchanged',
        },
        {
          label: 'Replace…',
          description: 'Enter a new secret (overwrites the saved one)',
          value: 'replace',
        },
        {
          label: 'Delete secret',
          description: 'Remove the saved secret (profile becomes unusable until re-added)',
          value: 'delete',
        },
      ],
      { title: `Edit Provider: Secret for "${profile.name}"`, ignoreFocusOut: true },
    );
    if (!action) return undefined;
    secretAction = action.value as 'unchanged' | 'replace' | 'delete';
  }

  let newSecret: string | undefined;
  if (secretAction === 'replace') {
    newSecret = normalizeProviderSecret(
      await vscode.window.showInputBox({
        title: `Edit Provider: New Secret for "${profile.name}"`,
        password: true,
        placeHolder: 'paste secret…',
        ignoreFocusOut: true,
      }),
    );
    if (!newSecret) return undefined;
  }

  // 4. Enable / disable
  const enablePick = await vscode.window.showQuickPick(
    [
      { label: 'Enabled', description: 'Appears in New Agent / Switch Provider', value: true },
      { label: 'Disabled', description: 'Hidden from New Agent / Switch Provider', value: false },
    ],
    {
      title: `Edit Provider: Status of "${profile.name}"`,
      ignoreFocusOut: true,
    },
  );
  if (!enablePick) return undefined;
  updated.enabled = enablePick.value === true;

  const err = validateProviderProfile(updated);
  if (err) {
    void vscode.window.showErrorMessage(`Claude Fleet: ${err}`);
    return undefined;
  }

  // Apply secret action BEFORE persisting the profile (consistent order).
  if (secretAction === 'replace' && updated.secretRef && newSecret !== undefined) {
    try {
      await deps.secretStorageProvider.set(updated.secretRef, newSecret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        `Claude Fleet: Failed to replace secret: ${msg}. Aborting edit.`,
      );
      return undefined;
    }
  } else if (secretAction === 'delete' && updated.secretRef) {
    try {
      await deps.secretStorageProvider.delete(updated.secretRef);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        `Claude Fleet: Failed to delete secret: ${msg}. Aborting edit.`,
      );
      return undefined;
    }
  }

  await deps.providerProfileStore.upsert(updated);
  return updated;
}

// Re-export for tests / callers.
export type { AuthMode };
