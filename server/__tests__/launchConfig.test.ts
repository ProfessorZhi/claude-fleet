/**
 * Spec 002 — isolation tests for resolveClaudeLaunchConfig + ProviderProfile
 * validation + persist metadata flow.
 *
 * Goal: prove that two agents with different Provider Profiles produce
 * independent env, args, and safeMetadata, and that secrets never leak
 * into safe metadata.
 */

import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../core/src/providerProfiles.js';
import {
  INHERIT_PROVIDER_PROFILE_ID,
  makeInheritProviderProfile,
  validateProviderProfile,
} from '../../core/src/providerProfiles.js';
import {
  MissingSecretError,
  ModelRequiredError,
  resolveClaudeLaunchConfig,
} from '../src/launchConfig.js';

const SECRET_A = 'sk-ant-secret-AAAA-AAAA-AAAA-AAAA';
const SECRET_B = 'sk-ant-secret-BBBB-BBBB-BBBB-BBBB';

function makeCustomProfile(opts: {
  id: string;
  name: string;
  baseUrl?: string;
  authMode: 'apiKey' | 'authToken';
  secretRef: string;
  defaultModelId?: string;
}): ProviderProfile {
  return {
    id: opts.id,
    name: opts.name,
    kind: 'anthropic-compatible',
    baseUrl: opts.baseUrl,
    authMode: opts.authMode,
    secretRef: opts.secretRef,
    defaultModelId: opts.defaultModelId,
  };
}

describe('resolveClaudeLaunchConfig — Spec 002 isolation', () => {
  it('resolves a provider default model and records safe requested/resolved diagnostics', () => {
    const profile = makeCustomProfile({
      id: 'deepseek-profile',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authMode: 'authToken',
      secretRef: 'deepseek-secret',
      defaultModelId: 'deepseek-v4-flash',
    });
    const result = resolveClaudeLaunchConfig(
      profile,
      undefined,
      '/repo',
      'session',
      () => SECRET_A,
    );

    expect(result.args).toContain('--model');
    expect(result.args).toContain('deepseek-v4-flash');
    expect(result.safeMetadata).toMatchObject({
      requestedProviderProfileId: 'deepseek-profile',
      resolvedProviderProfileId: 'deepseek-profile',
      requestedModelId: undefined,
      resolvedModelId: 'deepseek-v4-flash',
      modelId: 'deepseek-v4-flash',
      credential: 'present',
      refPresent: true,
      refResolution: 'success',
      authConfigured: true,
      authInjected: true,
      authVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
      baseUrlHost: 'api.deepseek.com',
    });
    expect(JSON.stringify(result.safeMetadata)).not.toContain(SECRET_A);
  });

  it('rejects a configured provider without a requested or default model', () => {
    const profile = makeCustomProfile({
      id: 'missing-model',
      name: 'Missing Model',
      authMode: 'apiKey',
      secretRef: 'missing-model-secret',
    });
    expect(() =>
      resolveClaudeLaunchConfig(profile, undefined, '/repo', 'session', () => SECRET_A),
    ).toThrow(ModelRequiredError);
    expect(() =>
      resolveClaudeLaunchConfig(profile, undefined, '/repo', 'session', () => SECRET_A),
    ).toThrow('MODEL_REQUIRED');
  });

  it('keeps explicit Inherit credential-free and allows native model selection', () => {
    const result = resolveClaudeLaunchConfig(
      makeInheritProviderProfile(),
      undefined,
      '/repo',
      'session',
      () => SECRET_A,
    );
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.safeMetadata).toMatchObject({
      requestedProviderProfileId: INHERIT_PROVIDER_PROFILE_ID,
      resolvedProviderProfileId: INHERIT_PROVIDER_PROFILE_ID,
      credential: 'absent',
      refPresent: false,
      refResolution: 'not_required',
      authConfigured: false,
      authInjected: false,
      authVariableNames: [],
    });
  });

  it('two profiles produce independent env objects (Test 1)', () => {
    const profileA = makeCustomProfile({
      id: 'a',
      name: 'Provider A',
      baseUrl: 'https://a.example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.a',
      defaultModelId: 'model-a',
    });
    const profileB = makeCustomProfile({
      id: 'b',
      name: 'Provider B',
      baseUrl: 'https://b.example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.b',
      defaultModelId: 'model-b',
    });

    const secretMap = new Map<string, string>([
      ['claude-fleet.provider.a', SECRET_A],
      ['claude-fleet.provider.b', SECRET_B],
    ]);

    const a = resolveClaudeLaunchConfig(profileA, 'model-a', '/repo-a', 'sa', (ref) =>
      secretMap.get(ref),
    );
    const b = resolveClaudeLaunchConfig(profileB, 'model-b', '/repo-b', 'sb', (ref) =>
      secretMap.get(ref),
    );

    // Test 1 — env objects must be independent references.
    expect(a.env).not.toBe(b.env);
    expect(a.env.ANTHROPIC_BASE_URL).toBe('https://a.example.com');
    expect(b.env.ANTHROPIC_BASE_URL).toBe('https://b.example.com');

    // Mutating one must not affect the other.
    a.env.ANTHROPIC_BASE_URL = 'https://mutated.example.com';
    expect(b.env.ANTHROPIC_BASE_URL).toBe('https://b.example.com');

    // Mutating one must not affect the other (api key).
    expect(a.env.ANTHROPIC_API_KEY).toBe(SECRET_A);
    expect(b.env.ANTHROPIC_API_KEY).toBe(SECRET_B);
    a.env.ANTHROPIC_API_KEY = 'mutated';
    expect(b.env.ANTHROPIC_API_KEY).toBe(SECRET_B);
  });

  it('modifying a Profile after a previous resolve does NOT change the resolved env (Test 2)', () => {
    const profileA: ProviderProfile = makeCustomProfile({
      id: 'a',
      name: 'Provider A',
      baseUrl: 'https://a.example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.a',
    });
    const profileB: ProviderProfile = makeCustomProfile({
      id: 'b',
      name: 'Provider B',
      baseUrl: 'https://b.example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.b',
    });

    // Resolve B first; this represents the "already running" instance.
    const bEnv = resolveClaudeLaunchConfig(profileB, 'mb', '/repo-b', 'sb', () => SECRET_B).env;
    expect(bEnv.ANTHROPIC_BASE_URL).toBe('https://b.example.com');

    // Now mutate A's profile (e.g. user edits it in the Provider Manager).
    profileA.baseUrl = 'https://a-mutated.example.com';

    // B's resolved env MUST be unchanged.
    expect(bEnv.ANTHROPIC_BASE_URL).toBe('https://b.example.com');
  });

  it('per-instance --model is appended to args; each instance gets its own (Test 3)', () => {
    const inheritA = makeInheritProviderProfile();
    inheritA.id = 'custom-a';
    inheritA.name = 'A';
    inheritA.defaultModelId = undefined;

    const profileA: ProviderProfile = { ...inheritA, defaultModelId: 'model-a' };
    const profileB: ProviderProfile = { ...inheritA, defaultModelId: 'model-b' };

    const a = resolveClaudeLaunchConfig(profileA, 'model-a', '/repo-a', 'sa', () => undefined);
    const b = resolveClaudeLaunchConfig(profileB, 'model-b', '/repo-b', 'sb', () => undefined);

    expect(a.args).toContain('--model');
    expect(a.args).toContain('model-a');
    expect(b.args).toContain('--model');
    expect(b.args).toContain('model-b');

    // Each call returns a fresh args array.
    expect(a.args).not.toBe(b.args);
  });

  it('secrets NEVER appear in safeMetadata (Test 4)', () => {
    const profileA = makeCustomProfile({
      id: 'a',
      name: 'Provider A',
      baseUrl: 'https://a.example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.a',
    });

    const result = resolveClaudeLaunchConfig(profileA, 'model-a', '/repo-a', 'sa', () => SECRET_A);

    // Diagnostics are safe to serialize and contain no credential material.
    expect(Object.keys(result.safeMetadata).sort()).toEqual([
      'authConfigured',
      'authInjected',
      'authVariableNames',
      'baseUrlHost',
      'credential',
      'modelId',
      'providerDisplayName',
      'providerProfileId',
      'refPresent',
      'refResolution',
      'requestedModelId',
      'requestedProviderProfileId',
      'resolvedModelId',
      'resolvedProviderProfileId',
    ]);

    // safeMetadata JSON MUST NOT contain the secret.
    const dump = JSON.stringify(result.safeMetadata);
    expect(dump).not.toContain(SECRET_A);
    expect(dump).not.toContain('sk-ant-');
    expect(dump).not.toContain('Authorization');
    expect(dump).not.toContain('X-Api-Key');

    // env MAY contain the secret (it's needed by Claude Code); that's expected.
    expect(result.env.ANTHROPIC_API_KEY).toBe(SECRET_A);
  });

  it('inherit profile does NOT inject auth env, but DOES inject baseUrl if present', () => {
    const inherit = makeInheritProviderProfile();
    // Inherit + no baseUrl: no ANTHROPIC_* injected at all.
    const r1 = resolveClaudeLaunchConfig(inherit, undefined, '/repo', 's', () => SECRET_X);
    expect(r1.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r1.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(r1.env.ANTHROPIC_BASE_URL).toBeUndefined();

    // Inherit + baseUrl: only baseUrl injected.
    const inheritWithBase = { ...inherit, baseUrl: 'https://example.com' };
    const r2 = resolveClaudeLaunchConfig(inheritWithBase, undefined, '/repo', 's', () => SECRET_X);
    expect(r2.env.ANTHROPIC_BASE_URL).toBe('https://example.com');
    expect(r2.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('authToken profile injects ANTHROPIC_AUTH_TOKEN (not API_KEY)', () => {
    const profile = makeCustomProfile({
      id: 'tok',
      name: 'Token Provider',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.tok',
    });
    const result = resolveClaudeLaunchConfig(profile, 'model', '/repo', 's', () => 'bearer-token');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('bearer-token');
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('missing secret for apiKey profile FAILS CLOSED with MissingSecretError (no fallback)', () => {
    const profile = makeCustomProfile({
      id: 'missing',
      name: 'Missing Secret Provider',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.missing',
    });
    let threw = false;
    try {
      resolveClaudeLaunchConfig(profile, 'model', '/repo', 's', () => undefined);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(MissingSecretError);
      const mse = e as MissingSecretError;
      expect(mse.profileId).toBe('missing');
      expect(mse.profileName).toBe('Missing Secret Provider');
      expect(mse.authMode).toBe('apiKey');
      // The error message must mention the profile name and ask the user to
      // reconfigure — never suggest "we'll just fall back to your login".
      expect(mse.message).toContain('Missing Secret Provider');
      expect(mse.message).toMatch(/Secret/i);
    }
    expect(threw).toBe(true);
  });

  it('missing secret for authToken profile FAILS CLOSED with MissingSecretError', () => {
    const profile = makeCustomProfile({
      id: 'missing-tok',
      name: 'Missing Token Provider',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.missing-tok',
    });
    expect(() =>
      resolveClaudeLaunchConfig(profile, 'model', '/repo', 's', () => undefined),
    ).toThrowError(MissingSecretError);
  });

  it('empty-string secret for apiKey profile FAILS CLOSED (whitespace-only too)', () => {
    const profile = makeCustomProfile({
      id: 'empty',
      name: 'Empty Secret Provider',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.empty',
    });
    expect(() => resolveClaudeLaunchConfig(profile, 'model', '/repo', 's', () => '')).toThrowError(
      MissingSecretError,
    );
  });

  it('inherit profile does NOT require a secret (no throw)', () => {
    const inherit = makeInheritProviderProfile();
    expect(() =>
      resolveClaudeLaunchConfig(inherit, undefined, '/repo', 's', () => undefined),
    ).not.toThrow();
  });

  it('always adds PWD; never includes secret in safeMetadata for any auth mode', () => {
    const cases: Array<{ authMode: 'apiKey' | 'authToken' | 'inherit' }> = [
      { authMode: 'apiKey' },
      { authMode: 'authToken' },
      { authMode: 'inherit' },
    ];
    for (const c of cases) {
      const profile: ProviderProfile = {
        id: `case-${c.authMode}`,
        name: `Case ${c.authMode}`,
        kind: 'anthropic-compatible',
        authMode: c.authMode,
        secretRef: c.authMode === 'inherit' ? undefined : 'claude-fleet.provider.case',
      };
      const r = resolveClaudeLaunchConfig(profile, 'model', '/wd', 's', () => SECRET_A);
      expect(r.env.PWD).toBe('/wd');
      expect(JSON.stringify(r.safeMetadata)).not.toContain(SECRET_A);
    }
  });

  it('args always include --session-id; bypassPermissions adds --dangerously-skip-permissions', () => {
    const profile = makeInheritProviderProfile();
    const noBypass = resolveClaudeLaunchConfig(
      profile,
      undefined,
      '/repo',
      'sid-1',
      () => undefined,
    );
    expect(noBypass.args).toContain('--session-id');
    expect(noBypass.args).toContain('sid-1');
    expect(noBypass.args).not.toContain('--dangerously-skip-permissions');

    const withBypass = resolveClaudeLaunchConfig(
      profile,
      undefined,
      '/repo',
      'sid-2',
      () => undefined,
      { bypassPermissions: true },
    );
    expect(withBypass.args).toContain('--dangerously-skip-permissions');
  });

  it('safeMetadata uses profile.id and profile.name verbatim', () => {
    const profile: ProviderProfile = {
      id: INHERIT_PROVIDER_PROFILE_ID,
      name: 'Custom Inherit Name',
      kind: 'anthropic-compatible',
      authMode: 'inherit',
    };
    const r = resolveClaudeLaunchConfig(profile, 'm', '/repo', 's', () => undefined);
    expect(r.safeMetadata.providerProfileId).toBe(INHERIT_PROVIDER_PROFILE_ID);
    expect(r.safeMetadata.providerDisplayName).toBe('Custom Inherit Name');
    expect(r.safeMetadata.modelId).toBe('m');
  });
});

// Avoid hoisting-SECRET_A clashes; just a marker.
const SECRET_X = 'sk-ant-secret-XXXX-XXXX-XXXX-XXXX';

describe('validateProviderProfile — invariants', () => {
  it('rejects apiKey profile without secretRef', () => {
    const p: ProviderProfile = {
      id: 'p',
      name: 'P',
      kind: 'anthropic-compatible',
      authMode: 'apiKey',
    };
    expect(validateProviderProfile(p)).toMatch(/requires a secret/);
  });

  it('rejects authToken profile without secretRef', () => {
    const p: ProviderProfile = {
      id: 'p',
      name: 'P',
      kind: 'anthropic-compatible',
      authMode: 'authToken',
    };
    expect(validateProviderProfile(p)).toMatch(/requires a secret/);
  });

  it('rejects inherit profile with secretRef (unused)', () => {
    const p: ProviderProfile = {
      id: 'p',
      name: 'P',
      kind: 'anthropic-compatible',
      authMode: 'inherit',
      secretRef: 'claude-fleet.provider.unused',
    };
    expect(validateProviderProfile(p)).toMatch(/unused/);
  });

  it('rejects customHeaders with reserved auth header names', () => {
    for (const reserved of ['authorization', 'x-api-key', 'x-auth-token', 'Authorization']) {
      const p: ProviderProfile = {
        id: 'p',
        name: 'P',
        kind: 'anthropic-compatible',
        authMode: 'inherit',
        customHeaders: { [reserved]: 'value' },
      };
      expect(validateProviderProfile(p)).toMatch(/reserved auth header/);
    }
  });

  it('rejects invalid baseUrl', () => {
    const p: ProviderProfile = {
      id: 'p',
      name: 'P',
      kind: 'anthropic-compatible',
      authMode: 'inherit',
      baseUrl: 'not-a-url',
    };
    expect(validateProviderProfile(p)).toMatch(/baseUrl/);
  });

  it('accepts a complete valid custom profile', () => {
    const p: ProviderProfile = {
      id: 'p',
      name: 'P',
      kind: 'anthropic-compatible',
      baseUrl: 'https://example.com',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.p',
      defaultModelId: 'some-model',
    };
    expect(validateProviderProfile(p)).toBeNull();
  });
});

describe('resolveClaudeLaunchConfig — Spec 005 provider types', () => {
  const noSecret = () => undefined;

  it('native-anthropic profile injects NO ANTHROPIC_* auth env', () => {
    const profile: ProviderProfile = {
      id: 'nat',
      name: 'Anthropic Personal',
      kind: 'anthropic-compatible',
      providerType: 'native-anthropic',
      presetId: 'anthropic-account',
      authMode: 'inherit',
    };
    const r = resolveClaudeLaunchConfig(profile, 'claude-sonnet', '/repo', 's', noSecret);
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(r.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('deepseek preset injects official base URL + token + official env block', () => {
    const profile: ProviderProfile = {
      id: 'deepseek.1',
      name: 'DeepSeek - Main',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-compatible',
      presetId: 'deepseek',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.deepseek.1',
    };
    const r = resolveClaudeLaunchConfig(profile, undefined, '/repo', 's', () => 'sk-deepseek-key');
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-deepseek-key');
    expect(r.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]');
    expect(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash');
    // Secrets never in safeMetadata.
    expect(r.safeMetadata.providerProfileId).toBe('deepseek.1');
    expect(JSON.stringify(r.safeMetadata)).not.toContain('sk-deepseek-key');
  });

  it('minimax preset injects official base URL + compact window env', () => {
    const profile: ProviderProfile = {
      id: 'minimax.1',
      name: 'MiniMax - Main',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-compatible',
      presetId: 'minimax',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.minimax.1',
    };
    const r = resolveClaudeLaunchConfig(profile, undefined, '/repo', 's', () => 'mm-key');
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic');
    expect(r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
  });

  it('trims an existing auth token before injecting it into the terminal', () => {
    const profile: ProviderProfile = {
      id: 'minimax.trimmed',
      name: 'MiniMax - Trimmed',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-compatible',
      presetId: 'minimax',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.minimax.trimmed',
    };
    const r = resolveClaudeLaunchConfig(profile, undefined, '/repo', 's', () => '  mm-key\r\n');
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe('mm-key');
  });

  it('explicit baseUrl overrides the preset default; explicit model wins via args', () => {
    const profile: ProviderProfile = {
      id: 'deepseek.2',
      name: 'DeepSeek - CN',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-compatible',
      presetId: 'deepseek',
      baseUrl: 'https://mirror.example.com/anthropic',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.deepseek.2',
    };
    const r = resolveClaudeLaunchConfig(profile, 'custom-model', '/repo', 's', () => 'k');
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://mirror.example.com/anthropic');
    // --model is an explicit arg (overrides env ANTHROPIC_MODEL per Claude Code).
    expect(r.args).toContain('--model');
    expect(r.args).toContain('custom-model');
  });

  it('external-credential-chain (bedrock/vertex/foundry) injects no ANTHROPIC_*', () => {
    for (const preset of ['bedrock', 'vertex', 'foundry'] as const) {
      const profile: ProviderProfile = {
        id: `${preset}.1`,
        name: `${preset} - Work`,
        kind: 'anthropic-compatible',
        providerType: preset,
        presetId: preset,
        authMode: 'inherit',
      };
      const r = resolveClaudeLaunchConfig(profile, 'claude-sonnet', '/repo', 's', noSecret);
      expect(r.env.ANTHROPIC_API_KEY, preset).toBeUndefined();
      expect(r.env.ANTHROPIC_AUTH_TOKEN, preset).toBeUndefined();
      expect(r.env.ANTHROPIC_BASE_URL, preset).toBeUndefined();
    }
  });

  it('anthropic-api profile injects API key', () => {
    const profile: ProviderProfile = {
      id: 'api.1',
      name: 'Anthropic API',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-api',
      presetId: 'anthropic-api',
      authMode: 'apiKey',
      secretRef: 'claude-fleet.provider.api.1',
    };
    const r = resolveClaudeLaunchConfig(profile, 'claude-sonnet', '/repo', 's', () => 'sk-ant-123');
    expect(r.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');
  });

  it('missing secret still fails closed on preset profiles', () => {
    const profile: ProviderProfile = {
      id: 'deepseek.3',
      name: 'DeepSeek - Broken',
      kind: 'anthropic-compatible',
      providerType: 'anthropic-compatible',
      presetId: 'deepseek',
      authMode: 'authToken',
      secretRef: 'claude-fleet.provider.deepseek.3',
    };
    expect(() =>
      resolveClaudeLaunchConfig(profile, 'claude-sonnet', '/repo', 's', noSecret),
    ).toThrow(MissingSecretError);
  });
});
