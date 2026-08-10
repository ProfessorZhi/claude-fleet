import { describe, expect, test } from 'vitest';

import {
  buildVesselVisualState,
  normalizeVesselStatus,
  vesselTypeForRole,
} from '../src/fleet/visualState.js';

describe('Fleet vessel visual state', () => {
  test('keeps role-derived vessel type separate from runtime badge', () => {
    expect(vesselTypeForRole('worker')).toBe('frigate');
    expect(
      buildVesselVisualState({ role: 'worker', status: 'working', runtime: 'codex-cli' }),
    ).toMatchObject({
      vesselType: 'frigate',
      runtimeBadge: 'Codex',
      engine: 'active',
      motion: 'cruise',
      beacon: 'none',
    });
    expect(
      buildVesselVisualState({ role: 'worker', status: 'working', runtime: 'claude-code' })
        .vesselType,
    ).toBe('frigate');
  });

  test('composes waiting, error, selection, and transient completion independently', () => {
    expect(
      buildVesselVisualState({
        role: 'reviewer',
        status: 'waiting',
        selected: true,
        completionPulse: true,
      }),
    ).toMatchObject({
      status: 'waiting',
      vesselType: 'recon',
      engine: 'idle',
      beacon: 'waiting',
      motion: 'hover',
      selected: true,
      completionPulse: true,
    });
    expect(buildVesselVisualState({ role: 'worker', status: 'error' })).toMatchObject({
      engine: 'off',
      beacon: 'error',
      motion: 'hover',
    });
  });

  test('normalizes unknown values to a safe idle fallback', () => {
    expect(normalizeVesselStatus('not-a-runtime-state')).toBe('idle');
    expect(buildVesselVisualState({ role: 'subagent', status: 'unknown' })).toMatchObject({
      status: 'idle',
      vesselType: 'drone',
    });
  });
});
