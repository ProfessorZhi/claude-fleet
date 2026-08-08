/**
 * Spec 005 — ProviderDefinition / ProviderRegistry tests.
 *
 * Definitions must ONLY carry official, documented values; unverified
 * presets must carry no endpoint/model (never invent values). The DeepSeek /
 * MiniMax entries are verified against their official Claude Code
 * integration docs (see core/src/providerRegistry.ts sources).
 */

import { describe, expect, it } from 'vitest';

import {
  getProviderDefinition,
  getVerifiedProviderDefinitions,
  PROVIDER_DEFINITIONS,
  type ProviderDefinition,
} from '../../core/src/providerRegistry.js';

describe('ProviderRegistry — Spec 005', () => {
  it('defines all expected provider types', () => {
    const ids = PROVIDER_DEFINITIONS.map((d) => d.id);
    for (const id of [
      'anthropic-account',
      'anthropic-api',
      'bedrock',
      'vertex',
      'foundry',
      'deepseek',
      'minimax',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('deepseek preset matches the official DeepSeek Claude Code docs', () => {
    const d = getProviderDefinition('deepseek')!;
    expect(d).toBeDefined();
    expect(d.providerType).toBe('anthropic-compatible');
    expect(d.authStrategy).toBe('auth-token');
    expect(d.defaultEndpoint).toBe('https://api.deepseek.com/anthropic');
    // Official env block (api-docs.deepseek.com — Integrate with Claude Code).
    expect(d.requiredEnv).toMatchObject({
      ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
    });
    expect(d.verified).toBe(true);
    expect(d.source?.url).toContain('api-docs.deepseek.com');
  });

  it('minimax preset matches the official MiniMax Claude Code docs', () => {
    const d = getProviderDefinition('minimax')!;
    expect(d).toBeDefined();
    expect(d.providerType).toBe('anthropic-compatible');
    expect(d.authStrategy).toBe('auth-token');
    expect(d.defaultEndpoint).toBe('https://api.minimax.io/anthropic');
    expect(d.supportedModelHints).toContain('MiniMax-M3[1m]');
    expect(d.requiredEnv).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      ANTHROPIC_MODEL: 'MiniMax-M3[1m]',
    });
    expect(d.verified).toBe(true);
    expect(d.source?.url).toContain('platform.minimax.io');
  });

  it('native providers use external credential chains without endpoints', () => {
    for (const id of ['bedrock', 'vertex', 'foundry']) {
      const d = getProviderDefinition(id)!;
      expect(d.authStrategy).toBe('external-credential-chain');
      expect(d.defaultEndpoint).toBeUndefined();
    }
  });

  it('anthropic-account is native-login with no env requirements', () => {
    const d = getProviderDefinition('anthropic-account')!;
    expect(d.providerType).toBe('native-anthropic');
    expect(d.authStrategy).toBe('native-login');
    expect(d.requiredEnv).toBeUndefined();
    expect(d.defaultEndpoint).toBeUndefined();
  });

  it('every verified definition carries a source URL; every unverified one carries no endpoint/model', () => {
    for (const d of PROVIDER_DEFINITIONS) {
      if (d.verified) {
        expect(d.source?.url, `${d.id} should cite an official source`).toBeTruthy();
      } else {
        // Never invent endpoints / models for unverified presets.
        expect(d.defaultEndpoint, `${d.id} must not invent an endpoint`).toBeUndefined();
        expect(d.supportedModelHints, `${d.id} must not invent models`).toBeUndefined();
      }
    }
  });

  it('getVerifiedProviderDefinitions returns only verified entries', () => {
    const verified = getVerifiedProviderDefinitions();
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every((d) => d.verified)).toBe(true);
  });
});

// Keep a typed reference so the export shape stays stable.
export type { ProviderDefinition };
