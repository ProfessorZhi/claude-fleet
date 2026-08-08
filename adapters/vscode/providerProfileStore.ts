/**
 * ProviderProfileStore — Spec 002 / Spec 005.
 *
 * Persists ProviderProfile (NON-secret configuration) in VS Code globalState.
 * The plaintext secret lives in SecretStorage under `secretRef`.
 *
 * Storage shape:
 *   globalState['claudeFleet.providers'] = ProviderProfile[]
 *
 * Invariants:
 *   - SecretStorage plaintext NEVER appears here.
 *   - Spec 005 (FR-003/FR-005): `list()` returns ONLY user-configured profiles.
 *     The built-in Inherit profile is NO LONGER auto-injected — Native
 *     Anthropic Account must be explicitly configured to appear in
 *     New Agent / Switch. `get(INHERIT_PROVIDER_PROFILE_ID)` still resolves
 *     for legacy restarts (001-era agents with no providerProfileId).
 *
 * See:
 *   docs/specs/002-provider-model-isolation/design.md § ProviderProfileStore
 *   docs/specs/005-provider-registry-session-continuity/design.md D1/D5
 */

import * as vscode from 'vscode';

import type { ProviderProfile } from '../../core/src/providerProfiles.js';
import {
  INHERIT_PROVIDER_PROFILE_ID,
  makeInheritProviderProfile,
} from '../../core/src/providerProfiles.js';

const STORAGE_KEY = 'claudeFleet.providers';

export interface ProviderProfileStore {
  list(): ProviderProfile[];
  get(id: string): ProviderProfile | undefined;
  upsert(profile: ProviderProfile): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createProviderProfileStore(
  extensionContext: Pick<vscode.ExtensionContext, 'globalState'>,
): ProviderProfileStore {
  const state = extensionContext.globalState;

  function readAll(): ProviderProfile[] {
    const raw = state.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    // Trust shape; runtime validation happens at upsert time.
    return raw.filter(
      (p): p is ProviderProfile => !!p && typeof p === 'object',
    ) as ProviderProfile[];
  }

  function writeAll(profiles: ProviderProfile[]): Promise<void> {
    // globalState.update returns Thenable<void>; wrap to a real Promise so callers
    // can `await` consistently with the rest of the codebase.
    return Promise.resolve(state.update(STORAGE_KEY, profiles));
  }

  return {
    list(): ProviderProfile[] {
      // Spec 005: only user-configured profiles. No auto-injected Inherit.
      return readAll().filter((p) => p && typeof p.id === 'string' && p.id.length > 0);
    },
    get(id: string): ProviderProfile | undefined {
      // Legacy restart fallback: 001-era agents persisted with
      // INHERIT_PROVIDER_PROFILE_ID resolve to the built-in inherit profile
      // (authMode 'inherit' → no env injection). It is NOT listed in UI.
      if (id === INHERIT_PROVIDER_PROFILE_ID) return makeInheritProviderProfile();
      return readAll().find((p) => p.id === id);
    },
    async upsert(profile: ProviderProfile): Promise<void> {
      if (profile.id === INHERIT_PROVIDER_PROFILE_ID) {
        throw new Error(`Cannot overwrite built-in profile id '${INHERIT_PROVIDER_PROFILE_ID}'.`);
      }
      const all = readAll().filter((p) => p.id !== profile.id);
      all.push(profile);
      await writeAll(all);
    },
    async remove(id: string): Promise<void> {
      if (id === INHERIT_PROVIDER_PROFILE_ID) {
        throw new Error(`Cannot remove built-in profile id '${INHERIT_PROVIDER_PROFILE_ID}'.`);
      }
      const all = readAll().filter((p) => p.id !== id);
      await writeAll(all);
    },
  };
}
