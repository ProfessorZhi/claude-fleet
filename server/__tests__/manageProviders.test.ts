/**
 * Spec 004 — Manage Providers deletion semantics.
 *
 * Focus on the pure core (`deleteProviderProfile`): the secret and the
 * profile must move together, with no orphan secrets and no half-deleted
 * state. Uses in-memory fakes for the store and SecretStorage.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock `vscode` so manageProvidersFlow.ts is importable outside the
// extension host (the module imports vscode at top level).
vi.mock('vscode', () => ({
  window: { showQuickPick: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
}));

import { deleteProviderProfile } from '../../adapters/vscode/manageProvidersFlow.js';
import type { ProviderProfileStore } from '../../adapters/vscode/providerProfileStore.js';
import type { SecretStorageProvider } from '../../adapters/vscode/secretStorageProvider.js';
import type { ProviderProfile } from '../../core/src/providerProfiles.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';

function customProfile(id: string, secretRef?: string): ProviderProfile {
  return {
    id,
    name: `Provider ${id}`,
    kind: 'anthropic-compatible',
    authMode: 'apiKey',
    secretRef,
  };
}

function fakeStore(initial: ProviderProfile[] = []) {
  const profiles = new Map(initial.map((p) => [p.id, p]));
  const remove = vi.fn(async (id: string) => {
    profiles.delete(id);
  });
  return {
    profiles,
    remove,
    get: (id: string) => profiles.get(id),
  } as unknown as ProviderProfileStore;
}

function fakeSecrets(deleted: string[] = []): SecretStorageProvider & { deleted: string[] } {
  return {
    deleted,
    get: async () => undefined,
    set: async () => {},
    isAvailable: () => true,
    delete: vi.fn(async (ref: string) => {
      deleted.push(ref);
    }),
  } as unknown as SecretStorageProvider & { deleted: string[] };
}

describe('deleteProviderProfile — Spec 004 FR-010', () => {
  it('deletes BOTH the profile and its secret (no orphan secret)', async () => {
    const store = fakeStore([customProfile('custom.a', 'claude-fleet.provider.a')]);
    const secrets = fakeSecrets();

    const err = await deleteProviderProfile(
      store,
      secrets,
      customProfile('custom.a', 'claude-fleet.provider.a'),
    );

    expect(err).toBeUndefined();
    expect(secrets.deleted).toEqual(['claude-fleet.provider.a']);
    expect(store.remove).toHaveBeenCalledWith('custom.a');
    expect(store.get('custom.a')).toBeUndefined();
  });

  it('profile without secretRef is deleted without touching SecretStorage', async () => {
    const store = fakeStore([customProfile('custom.b')]);
    const secrets = fakeSecrets();

    const err = await deleteProviderProfile(store, secrets, customProfile('custom.b'));

    expect(err).toBeUndefined();
    expect(secrets.deleted).toEqual([]);
    expect(store.remove).toHaveBeenCalledWith('custom.b');
  });

  it('secret delete failure aborts — profile is NOT deleted (no half-deleted state)', async () => {
    const store = fakeStore([customProfile('custom.c', 'claude-fleet.provider.c')]);
    const secrets = {
      delete: vi.fn(async () => {
        throw new Error('SecretStorage unavailable');
      }),
    } as unknown as SecretStorageProvider;

    const err = await deleteProviderProfile(
      store,
      secrets,
      customProfile('custom.c', 'claude-fleet.provider.c'),
    );

    expect(err).toContain('Profile NOT deleted');
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.get('custom.c')).toBeDefined();
  });

  it('built-in Inherit profile can never be deleted', async () => {
    const store = fakeStore();
    const secrets = fakeSecrets();

    const err = await deleteProviderProfile(store, secrets, {
      id: INHERIT_PROVIDER_PROFILE_ID,
      name: 'Anthropic (Inherit)',
      kind: 'anthropic-compatible',
      authMode: 'inherit',
    });

    expect(err).toContain('cannot be deleted');
    expect(store.remove).not.toHaveBeenCalled();
    expect(secrets.deleted).toEqual([]);
  });
});
