/**
 * manageProvidersFlow — Spec 004 Manage Providers command.
 *
 * QuickPick-based management: list all profiles (built-in Inherit + custom),
 * create new custom providers (reusing the launch flow's creation path), and
 * delete custom ones. Deleting a custom provider also deletes its
 * SecretStorage secret — no orphan secrets (FR-010).
 *
 * The deletion core (`deleteProviderProfile`) is separated from the vscode
 * UI so it is unit-testable with fakes.
 */

import * as vscode from 'vscode';

import type { ProviderProfile } from '../../core/src/providerProfiles.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import { type LaunchAgentFlowDeps, runCreateCustomProviderFlow } from './launchAgentFlow.js';
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

/**
 * Run the Manage Providers QuickPick flow (Spec 004 FR-009):
 *
 *   - "Anthropic (Inherit)"  → info message (built-in, not deletable)
 *   - "<custom profile>"     → confirm → delete (profile + secret)
 *   - "$(plus) Create Custom Provider…" → reuse the launch flow creation UI
 */
export async function runManageProvidersFlow(deps: LaunchAgentFlowDeps): Promise<void> {
  const profiles = deps.providerProfileStore.list();

  const items: Array<vscode.QuickPickItem & { profile?: ProviderProfile; isCreate?: boolean }> =
    profiles.map((p) => ({
      label: p.name,
      description:
        p.id === INHERIT_PROVIDER_PROFILE_ID
          ? 'Built-in (uses your existing Claude Code login)'
          : p.baseUrl,
      detail:
        p.id === INHERIT_PROVIDER_PROFILE_ID
          ? 'Always available'
          : `authMode: ${p.authMode}${p.defaultModelId ? ` · default model: ${p.defaultModelId}` : ''}`,
      profile: p,
    }));
  items.push({
    label: '$(plus) Create Custom Provider…',
    description: 'Configure a custom Anthropic-compatible endpoint',
    isCreate: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Manage Providers',
    ignoreFocusOut: true,
  });
  if (!picked) return;

  if (picked.isCreate) {
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

  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: '$(trash) Delete',
        description: `Permanently delete "${profile.name}" and its saved secret`,
        value: 'delete',
      },
      { label: 'Cancel', value: 'cancel' },
    ],
    { title: `Claude Fleet: Manage "${profile.name}"`, ignoreFocusOut: true },
  );
  if (!confirm || confirm.value !== 'delete') return;

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
