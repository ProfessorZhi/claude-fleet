/**
 * cliProviderStore — Spec 005 FR-014.
 *
 * CLI-side ProviderProfile persistence. The VS Code adapter stores profiles
 * in globalState + SecretStorage; the standalone CLI has no VS Code host, so
 * it keeps profiles in `~/.claude-fleet/profiles.json` and plaintext secrets
 * in `~/.claude-fleet/secrets.json`.
 *
 * ALPHA LIMITATION (documented): the CLI secret file is NOT encrypted. It is
 * written with 0o600 permissions on POSIX; on Windows it inherits the user
 * account ACL. VS Code users should prefer the extension (SecretStorage).
 *
 * The PROFILE SHAPE, validators and the resolver are the SAME core modules
 * the VS Code adapter uses — one Provider Registry serves both surfaces.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ProviderProfile } from '../../core/src/providerProfiles.js';
import { validateProviderProfile } from '../../core/src/providerProfiles.js';
import { stateDir } from './migrateStateDir.js';

export const PROFILES_FILE = 'profiles.json';
export const SECRETS_FILE = 'secrets.json';

export interface CliProviderStore {
  list(): ProviderProfile[];
  get(id: string): ProviderProfile | undefined;
  upsert(profile: ProviderProfile): Promise<void>;
  remove(id: string): Promise<void>;
  getSecret(ref: string): string | undefined;
  setSecret(ref: string, secret: string): Promise<void>;
  deleteSecret(ref: string): Promise<void>;
}

function profilesPath(): string {
  return path.join(stateDir(), PROFILES_FILE);
}

function secretsPath(): string {
  return path.join(stateDir(), SECRETS_FILE);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: chmod is a no-op; ACL governs */
  }
}

export function createCliProviderStore(): CliProviderStore {
  return {
    list(): ProviderProfile[] {
      const raw = readJson<unknown[]>(profilesPath(), []);
      if (!Array.isArray(raw)) return [];
      return raw.filter((p): p is ProviderProfile => !!p && typeof p === 'object');
    },
    get(id: string): ProviderProfile | undefined {
      return this.list().find((p) => p.id === id);
    },
    async upsert(profile: ProviderProfile): Promise<void> {
      const err = validateProviderProfile(profile);
      if (err) throw new Error(err);
      const all = this.list().filter((p) => p.id !== profile.id);
      all.push(profile);
      writeJson(profilesPath(), all);
    },
    async remove(id: string): Promise<void> {
      const all = this.list().filter((p) => p.id !== id);
      writeJson(profilesPath(), all);
    },
    getSecret(ref: string): string | undefined {
      const secrets = readJson<Record<string, string>>(secretsPath(), {});
      return secrets[ref];
    },
    async setSecret(ref: string, secret: string): Promise<void> {
      const secrets = readJson<Record<string, string>>(secretsPath(), {});
      secrets[ref] = secret;
      writeJson(secretsPath(), secrets);
    },
    async deleteSecret(ref: string): Promise<void> {
      const secrets = readJson<Record<string, string>>(secretsPath(), {});
      if (ref in secrets) {
        delete secrets[ref];
        writeJson(secretsPath(), secrets);
      }
    },
  };
}
