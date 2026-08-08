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
 * Caller responsibilities:
 *   - Pass a stable `secretLookup` closure. The default impl in the adapter
 *     layer delegates to `vscode.SecretStorage`.
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
      throw new Error(
        `resolveClaudeLaunchConfig: profile "${profile.id}" has authMode 'apiKey' but no secretRef.`,
      );
    }
    const secret = secretLookup(profile.secretRef);
    if (typeof secret === 'string' && secret.length > 0) {
      env.ANTHROPIC_API_KEY = secret;
    }
    // If secret is missing, deliberately omit the env var. The Claude Code
    // process will fall back to its other auth sources (subscription login).
    // The adapter layer surfaces the missing-secret condition separately.
  } else if (profile.authMode === 'authToken') {
    if (!profile.secretRef) {
      throw new Error(
        `resolveClaudeLaunchConfig: profile "${profile.id}" has authMode 'authToken' but no secretRef.`,
      );
    }
    const secret = secretLookup(profile.secretRef);
    if (typeof secret === 'string' && secret.length > 0) {
      env.ANTHROPIC_AUTH_TOKEN = secret;
    }
  } else if (profile.authMode === 'inherit') {
    // Deliberately do NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
    // The Claude Code process inherits the user's existing login.
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
