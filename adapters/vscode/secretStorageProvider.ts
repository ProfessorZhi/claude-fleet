/**
 * SecretStorageProvider — Spec 002.
 *
 * Thin wrapper over `vscode.SecretStorage` for storing Provider secrets
 * (API keys / auth tokens) keyed by `secretRef`.
 *
 * Invariants:
 *   - Plaintext secrets NEVER appear in logs / Webview DTOs / persisted state.
 *   - Secrets are only retrieved by `get(ref)` and only used at the moment a
 *     Claude Code terminal is launched (via `resolveClaudeLaunchConfig` →
 *     `env.ANTHROPIC_API_KEY`).
 *
 * See:
 *   docs/specs/002-provider-model-isolation/design.md § T005
 *   ADR-002 in .agent/knowledge/decisions.md
 */

import * as vscode from 'vscode';

/**
 * Stable prefix for all secret refs Claude Fleet creates. A ref looks like:
 *   claude-fleet.provider.<profile-id>
 *
 * Keeping a prefix lets us scope "delete all Claude Fleet secrets" if we ever
 * need to (currently we never delete on uninstall — see uninstall() below).
 */
export const SECRET_REF_PREFIX = 'claude-fleet.provider.';

export function makeSecretRefForProvider(providerId: string): string {
  return `${SECRET_REF_PREFIX}${providerId}`;
}

export function isClaudeFleetSecretRef(ref: string): boolean {
  return ref.startsWith(SECRET_REF_PREFIX);
}

export interface SecretStorageProvider {
  /** Returns the plaintext secret for the given ref, or `undefined` if absent. */
  get(ref: string): Promise<string | undefined>;
  /** Stores the plaintext secret at `ref`. Overwrites any existing value. */
  set(ref: string, value: string): Promise<void>;
  /** Deletes the secret at `ref`. No-op if absent. */
  delete(ref: string): Promise<void>;
  /**
   * True iff the underlying `vscode.SecretStorage` is available in this host.
   * (Some embedded hosts / test environments don't expose it.)
   */
  isAvailable(): boolean;
}

/**
 * Construct a SecretStorageProvider backed by VS Code's `SecretStorage`.
 *
 * If the host doesn't expose `secrets`, returns a provider whose `isAvailable()`
 * is false; `get/set/delete` will throw so the caller can surface a clear UI
 * message.
 */
export function createSecretStorageProvider(
  extensionContext: Pick<vscode.ExtensionContext, 'secrets'>,
): SecretStorageProvider {
  const secrets = extensionContext.secrets;
  const available = !!secrets;

  return {
    isAvailable() {
      return available;
    },
    async get(ref: string): Promise<string | undefined> {
      if (!available) {
        throw new Error('SecretStorage is not available in this VS Code host.');
      }
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error('SecretStorage.get: ref must be a non-empty string.');
      }
      // Note: NEVER log the returned value, even partially.
      return secrets.get(ref);
    },
    async set(ref: string, value: string): Promise<void> {
      if (!available) {
        throw new Error('SecretStorage is not available in this VS Code host.');
      }
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error('SecretStorage.set: ref must be a non-empty string.');
      }
      if (typeof value !== 'string') {
        throw new Error('SecretStorage.set: value must be a string.');
      }
      await secrets.store(ref, value);
    },
    async delete(ref: string): Promise<void> {
      if (!available) {
        throw new Error('SecretStorage is not available in this VS Code host.');
      }
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error('SecretStorage.delete: ref must be a non-empty string.');
      }
      await secrets.delete(ref);
    },
  };
}
