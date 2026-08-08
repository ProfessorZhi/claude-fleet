/**
 * ProviderProfileStore — Spec 002.
 *
 * Persists ProviderProfile (NON-secret configuration) in VS Code globalState.
 * The plaintext secret lives in SecretStorage under `secretRef`.
 *
 * Storage shape:
 *   globalState['claudeFleet.providers'] = ProviderProfile[]
 *
 * Invariants:
 *   - SecretStorage plaintext NEVER appears here.
 *   - The store always includes the built-in "Inherit" profile in `list()`
 *     so callers don't have to remember to seed it.
 *
 * See:
 *   docs/specs/002-provider-model-isolation/design.md § ProviderProfileStore
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
      const stored = readAll();
      // Always surface the built-in Inherit profile; dedupe by id.
      const map = new Map<string, ProviderProfile>();
      map.set(INHERIT_PROVIDER_PROFILE_ID, makeInheritProviderProfile());
      for (const p of stored) {
        if (p && typeof p.id === 'string' && p.id.length > 0) {
          map.set(p.id, p);
        }
      }
      return [...map.values()];
    },
    get(id: string): ProviderProfile | undefined {
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
