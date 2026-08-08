/**
 * ProviderProfile / ModelProfile / InstanceLaunchConfig — types for Spec 002.
 *
 * Goal: per-instance Provider / Model isolation for Claude Code agents (and any
 * future Coding Agent that adopts the same `HookProvider.buildLaunchCommand`
 * surface). These types are Agent-neutral and contain NO plaintext secrets.
 *
 * See:
 *   docs/specs/002-provider-model-isolation/requirements.md
 *   docs/specs/002-provider-model-isolation/design.md
 *   ADR-002 in .agent/knowledge/decisions.md
 *
 * Note: this module intentionally contains only TypeScript types and a small
 * hand-rolled validator (no zod / no runtime deps) to match the existing core/
 * style.
 */

// ── AuthMode ─────────────────────────────────────────────────

/**
 * How a ProviderProfile injects auth into the spawned Claude Code process.
 *
 * - `inherit`: do not inject any ANTHROPIC_* auth env. Claude Code uses whatever
 *   the user's existing login provides.
 * - `apiKey`: inject `ANTHROPIC_API_KEY=<secret>` (sent as `X-Api-Key` header).
 * - `authToken`: inject `ANTHROPIC_AUTH_TOKEN=<secret>` (sent as `Authorization:
 *   Bearer ...`).
 */
export type AuthMode = 'inherit' | 'apiKey' | 'authToken';

const VALID_AUTH_MODES: ReadonlySet<AuthMode> = new Set<AuthMode>([
  'inherit',
  'apiKey',
  'authToken',
]);

function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === 'string' && VALID_AUTH_MODES.has(value as AuthMode);
}

// ── ProviderProfile ──────────────────────────────────────────

/**
 * Provider profile — non-secret configuration describing *how* to call an
 * LLM endpoint. Plaintext secrets MUST NOT live here; only `secretRef`.
 */
export interface ProviderProfile {
  id: string;
  name: string;
  /** 'anthropic-compatible' for now; future variants (e.g. openai-compatible)
   *  can be added when a real second protocol is integrated. */
  kind: 'anthropic-compatible';
  /** When absent, the Claude Code default endpoint is used. */
  baseUrl?: string;
  authMode: AuthMode;
  /** Reference into VS Code SecretStorage. Required when authMode !== 'inherit'. */
  secretRef?: string;
  /** Reserved for future use; NOT currently injected as env in 002. */
  customHeaders?: Record<string, string>;
  /** Default Model if a new Instance picks this Profile without override. */
  defaultModelId?: string;
}

const RESERVED_AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'x-auth-token']);

/**
 * Provider invariants enforced at write time:
 * - `authMode !== 'inherit'` requires `secretRef`;
 * - `customHeaders` may not include auth-like header names (those are handled
 *   via authMode);
 * - `baseUrl`, when present, must look like a URL.
 *
 * Returns a human-readable error string, or null if the profile is valid.
 */
export function validateProviderProfile(p: ProviderProfile): string | null {
  if (!p.id || typeof p.id !== 'string') {
    return `Provider is missing required field 'id'.`;
  }
  if (!p.name || typeof p.name !== 'string') {
    return `Provider "${p.id}" is missing required field 'name'.`;
  }
  if (!isAuthMode(p.authMode)) {
    return `Provider "${p.name}" has invalid authMode '${String(p.authMode)}'.`;
  }
  if (p.kind !== 'anthropic-compatible') {
    return `Provider "${p.name}" has unsupported kind '${String(p.kind)}'.`;
  }
  if (p.authMode !== 'inherit' && !p.secretRef) {
    return `Provider "${p.name}" requires a secret when authMode is '${p.authMode}'.`;
  }
  if (p.secretRef && p.authMode === 'inherit') {
    return `Provider "${p.name}" has a secretRef but authMode is 'inherit'; secretRef would be unused.`;
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string' || p.baseUrl.trim() === '') {
      return `Provider "${p.name}" baseUrl must be a non-empty URL when present.`;
    }
    // Lightweight URL sanity check — strict parse happens at use time.
    try {
      new URL(p.baseUrl);
    } catch {
      return `Provider "${p.name}" baseUrl is not a valid URL.`;
    }
  }
  if (p.customHeaders) {
    if (typeof p.customHeaders !== 'object' || p.customHeaders === null) {
      return `Provider "${p.name}" customHeaders must be an object.`;
    }
    for (const [key, value] of Object.entries(p.customHeaders)) {
      if (RESERVED_AUTH_HEADER_NAMES.has(key.toLowerCase())) {
        return `Provider "${p.name}" customHeaders includes reserved auth header '${key}'.`;
      }
      if (typeof value !== 'string') {
        return `Provider "${p.name}" customHeaders.${key} must be a string.`;
      }
    }
  }
  return null;
}

/**
 * Lightweight structural type guard for a value that *looks* like a ProviderProfile.
 * Returns true if the value has at minimum the required shape (id, name, authMode, kind).
 *
 * Use `validateProviderProfile` for full invariant validation.
 */
export function isProviderProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    v.kind === 'anthropic-compatible' &&
    isAuthMode(v.authMode)
  );
}

// ── ModelProfile ─────────────────────────────────────────────

/**
 * A Model ID + optional display name. The `id` is passed verbatim to
 * `claude --model`; Claude Code accepts arbitrary model strings, so we do NOT
 * restrict to a known enum. Third-party gateways may use custom model ids.
 */
export interface ModelProfile {
  id: string;
  displayName?: string;
}

// ── InstanceLaunchConfig ─────────────────────────────────────

/**
 * Per-instance launch intent. Resolved via `resolveClaudeLaunchConfig` into a
 * concrete `ResolvedLaunchConfig` (env + args + safeMetadata) at spawn time.
 *
 * `cwd` may be empty; `launchNewTerminal` falls back to the first workspace
 * folder (or homedir) when empty. This lets callers like the auto-spawn path
 * use a one-liner `{ providerProfileId: 'claude-fleet.inherit' }`.
 */
export interface InstanceLaunchConfig {
  cwd?: string;
  providerProfileId: string;
  modelId?: string;
  /** Advanced: caller-provided extra env merged after the resolved env. */
  envOverride?: Record<string, string>;
}

/**
 * Lightweight structural type guard for InstanceLaunchConfig.
 */
export function isInstanceLaunchConfig(value: unknown): value is InstanceLaunchConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.cwd === undefined || typeof v.cwd === 'string') &&
    typeof v.providerProfileId === 'string' &&
    v.providerProfileId.length > 0
  );
}

// ── ResolvedLaunchConfig ─────────────────────────────────────

/**
 * Output of `resolveClaudeLaunchConfig`. Per-instance, never persisted.
 *
 * - `env` is the per-terminal env passed to `vscode.window.createTerminal`. It
 *   MAY contain ANTHROPIC_* values and MUST NOT be written to AgentState.
 * - `args` are appended to `claude` (after the program name).
 * - `safeMetadata` is the only return field safe to serialize.
 */
export interface ResolvedLaunchConfig {
  /** Per-instance env. Independent object per call. */
  env: Record<string, string>;
  /** Args appended to `claude` invocation. */
  args: string[];
  /** Serializable, secret-free metadata for AgentState / Webview DTO. */
  safeMetadata: ResolvedLaunchSafeMetadata;
}

export interface ResolvedLaunchSafeMetadata {
  providerProfileId: string;
  providerDisplayName: string;
  modelId?: string;
}

// ── Built-in profile IDs ─────────────────────────────────────

/** Stable id for the built-in "Inherit current Anthropic login" profile. */
export const INHERIT_PROVIDER_PROFILE_ID = 'claude-fleet.inherit';

/** Built-in profile that represents "no override; use user's existing Claude Code login". */
export function makeInheritProviderProfile(): ProviderProfile {
  return {
    id: INHERIT_PROVIDER_PROFILE_ID,
    name: 'Anthropic (Inherit)',
    kind: 'anthropic-compatible',
    authMode: 'inherit',
    defaultModelId: undefined,
  };
}
