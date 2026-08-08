/**
 * Launch config resolver — Spec 002.
 *
 * `resolveClaudeLaunchConfig` is a PURE function that maps a ProviderProfile +
 * Model + cwd + sessionId into:
 *   - `env`: per-terminal env passed to `vscode.window.createTerminal`
 *   - `args`: args appended to `claude` invocation
 *   - `safeMetadata`: serializable, secret-free metadata for AgentState / Webview
 *
 * The secret lookup is INJECTED (`secretLookup`) so the function stays pure
 * and easy to unit test. The adapter layer wires `secretLookup` to
 * `vscode.SecretStorage`.
 *
 * Important invariants:
 *   - `env` is ALWAYS a fresh object (callers can mutate without affecting
 *     sibling instances — see T011 isolation tests).
 *   - `safeMetadata` NEVER contains plaintext secrets or env contents.
 *   - `safeMetadata.providerProfileId` matches `profile.id`.
 *
 * See:
 *   docs/specs/002-provider-model-isolation/design.md § T006
 *   ADR-002 in .agent/knowledge/decisions.md
 */

import type {
  ProviderProfile,
  ResolvedLaunchConfig,
  ResolvedLaunchSafeMetadata,
} from '../../core/src/providerProfiles.js';

/** Function that returns the plaintext secret for a given `secretRef`,
 *  or `undefined` if not present. */
export type SecretLookup = (ref: string) => string | undefined;

export interface ResolveOptions {
  /** When true, append `--dangerously-skip-permissions` (legacy upstream flag). */
  bypassPermissions?: boolean;
}

/**
 * Pure function: build per-instance env + args + safe metadata.
 *
 * Fail-closed semantics (Spec 002 FR-004 + FR-010):
 *   - `authMode: 'apiKey'` or `'authToken'` REQUIRES a non-empty secret.
 *   - If the secret is missing or empty, this function THROWS a
 *     `MissingSecretError` carrying the profile id and authMode.
 *   - The throw happens BEFORE any `env` is returned, so callers can
 *     decide whether to proceed with `vscode.window.createTerminal`. They
 *     MUST NOT create the terminal and then surface the error.
 *   - `authMode: 'inherit'` does NOT require a secret.
 *
 * Caller responsibilities:
 *   - Pass a stable `secretLookup` closure. The default impl in the adapter
 *     layer delegates to `vscode.SecretStorage`.
 *   - Catch `MissingSecretError` and surface a clear UI message; do NOT
 *     catch it silently and let Claude Code fall back to a different
 *     auth source (that would be a Spec violation — see FR-004).
 *   - Ensure `profile` is valid (`validateProviderProfile`); this resolver
 *     assumes validity and does not re-validate to keep it pure and cheap.
 */
export function resolveClaudeLaunchConfig(
  profile: ProviderProfile,
  modelId: string | undefined,
  cwd: string,
  sessionId: string,
  secretLookup: SecretLookup,
  opts: ResolveOptions = {},
): ResolvedLaunchConfig {
  // ── env (fresh object every call) ─────────────────────────
  const env: Record<string, string> = {};

  // baseUrl — always present and process-scoped if defined.
  if (profile.baseUrl && profile.baseUrl.trim() !== '') {
    env.ANTHROPIC_BASE_URL = profile.baseUrl;
  }

  // auth — only inject when the profile opts into one.
  if (profile.authMode === 'apiKey') {
    if (!profile.secretRef) {
      // Programmer error — validateProviderProfile should have caught this.
      throw new MissingSecretError(profile.id, profile.name, 'apiKey');
    }
    const secret = secretLookup(profile.secretRef);
    if (typeof secret !== 'string' || secret.length === 0) {
      // Fail closed. NEVER silently fall back to the user's Anthropic
      // login — that would be misleading (the user thinks they're on a
      // Custom Provider when they're not).
      throw new MissingSecretError(profile.id, profile.name, 'apiKey');
    }
    env.ANTHROPIC_API_KEY = secret;
  } else if (profile.authMode === 'authToken') {
    if (!profile.secretRef) {
      throw new MissingSecretError(profile.id, profile.name, 'authToken');
    }
    const secret = secretLookup(profile.secretRef);
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new MissingSecretError(profile.id, profile.name, 'authToken');
    }
    env.ANTHROPIC_AUTH_TOKEN = secret;
  } else if (profile.authMode === 'inherit') {
    // Deliberately do NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
    // The Claude Code process inherits the user's existing login. No
    // secret is required or expected.
  }

  // PWD — match upstream behavior (so Claude Code's CWD detection agrees).
  env.PWD = cwd;

  // ── args ──────────────────────────────────────────────────
  const args: string[] = ['--session-id', sessionId];
  if (typeof modelId === 'string' && modelId.trim() !== '') {
    args.push('--model', modelId);
  }
  if (opts.bypassPermissions) {
    // Upstream compatibility: keep the legacy flag name.
    args.push('--dangerously-skip-permissions');
  }

  // ── safeMetadata (never contains plaintext secret or env values) ──
  const safeMetadata: ResolvedLaunchSafeMetadata = {
    providerProfileId: profile.id,
    providerDisplayName: profile.name,
    modelId: typeof modelId === 'string' && modelId.trim() !== '' ? modelId : undefined,
  };

  return { env, args, safeMetadata };
}

/**
 * Error thrown by `resolveClaudeLaunchConfig` when a Custom Provider
 * (apiKey or authToken) has a missing or empty secret in SecretStorage.
 *
 * The adapter layer MUST catch this, surface a UI message, and abort
 * before any `vscode.window.createTerminal` call.
 */
export class MissingSecretError extends Error {
  readonly profileId: string;
  readonly profileName: string;
  readonly authMode: 'apiKey' | 'authToken';

  constructor(profileId: string, profileName: string, authMode: 'apiKey' | 'authToken') {
    super(`Claude Fleet: Provider "${profileName}" 缺少 Secret，请重新配置该 Provider 后再启动。`);
    this.name = 'MissingSecretError';
    this.profileId = profileId;
    this.profileName = profileName;
    this.authMode = authMode;
  }
}
