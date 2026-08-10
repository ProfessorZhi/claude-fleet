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

import type { FleetIdentity } from './fleetContracts.js';
import type { ProviderType } from './providerRegistry.js';

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
 *
 * Spec 005 分层：ProviderDefinition（core/src/providerRegistry.ts）是类型
 * 模板；ProviderProfile 是用户配置实例（ADR-004）。`providerType` 是唯一
 * 分支点（resolver 按它分派），`presetId` 引用 definition —— 新增 Provider
 * 只加 definition + profile，Runtime 核心零改动。
 */
export interface ProviderProfile {
  id: string;
  name: string;
  /** 'anthropic-compatible' for now; future variants (e.g. openai-compatible)
   *  can be added when a real second protocol is integrated. */
  kind: 'anthropic-compatible';
  /** Spec 005: Provider 类型。缺省 'anthropic-compatible'（legacy 兼容）。 */
  providerType?: ProviderType;
  /** Spec 005: 引用 ProviderDefinition id（'deepseek' | 'minimax' …）。
   *  缺省无（custom / legacy）。 */
  presetId?: string;
  /** When absent, the Claude Code default endpoint is used. */
  baseUrl?: string;
  authMode: AuthMode;
  /** Reference into VS Code SecretStorage. Required when authMode !== 'inherit'. */
  secretRef?: string;
  /** Reserved for future use; NOT currently injected as env in 002. */
  customHeaders?: Record<string, string>;
  /** Default Model if a new Instance picks this Profile without override. */
  defaultModelId?: string;
  /** Spec 005: 该 Profile 可选的 model 列表（默认模型 + 可选候选）。 */
  modelIds?: string[];
  /** Spec 005: 是否在 New Agent / Switch 中可被选择。缺省 true（legacy）。 */
  enabled?: boolean;
}

const VALID_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'native-anthropic',
  'anthropic-api',
  'bedrock',
  'vertex',
  'foundry',
  'anthropic-compatible',
]);

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && VALID_PROVIDER_TYPES.has(value);
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
  if (p.providerType !== undefined && !isProviderType(p.providerType)) {
    return `Provider "${p.name}" has unsupported providerType '${String(p.providerType)}'.`;
  }
  if (p.presetId !== undefined && (typeof p.presetId !== 'string' || p.presetId.trim() === '')) {
    return `Provider "${p.name}" presetId must be a non-empty string when present.`;
  }
  if (p.modelIds !== undefined && !Array.isArray(p.modelIds)) {
    return `Provider "${p.name}" modelIds must be an array when present.`;
  }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    return `Provider "${p.name}" enabled must be a boolean when present.`;
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
 *
 * Spec 005 Session Continuity: `sessionMode` 决定 claude CLI 的会话参数 ——
 * `'new'`（默认）用 `--session-id <sessionId>`（新 UUID）；
 * `'resume'` 用 `--resume <sessionId>` 恢复同一 Claude 原生 Session。
 */
export interface InstanceLaunchConfig {
  cwd?: string;
  providerProfileId: string;
  modelId?: string;
  /** Human-facing Fleet label; independent from Claude Team agentName. */
  displayName?: string;
  /** Spec 005: 会话模式。缺省 'new'（与旧行为一致）。 */
  sessionMode?: 'new' | 'resume';
  /** Spec 005: 显式 sessionId。缺省时 launchNewTerminal 生成新 UUID。 */
  sessionId?: string;
  /** Advanced: caller-provided extra env merged after the resolved env. */
  envOverride?: Record<string, string>;
  /** Secret-free Coordinator/Worker correlation metadata. */
  fleet?: FleetIdentity;
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
    v.providerProfileId.length > 0 &&
    (v.displayName === undefined || typeof v.displayName === 'string') &&
    (v.sessionMode === undefined || v.sessionMode === 'new' || v.sessionMode === 'resume') &&
    (v.sessionId === undefined || typeof v.sessionId === 'string')
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
  /** Secret-free Coordinator/Worker correlation metadata. */
  fleet?: FleetIdentity;
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
