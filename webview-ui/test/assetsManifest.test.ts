import { describe, expect, test } from 'vitest';

import {
  FLEET_ASSET_MANIFEST,
  getVesselAssetSet,
  getVesselAssetSetForRole,
  vesselTypeForAssetRole,
} from '../src/fleet/assets/index.js';

const VESSEL_TYPES = ['flagship', 'frigate', 'recon', 'drone'] as const;
const ENGINE_STATES = ['off', 'idle', 'active'] as const;
const BEACON_STATES = ['none', 'waiting', 'error'] as const;

describe('Fleet Scene asset manifest', () => {
  test('exposes all role-based vessel types through deterministic fallback refs', () => {
    expect(FLEET_ASSET_MANIFEST).toMatchObject({
      version: 1,
      source: 'deterministic-fallback',
    });

    for (const vesselType of VESSEL_TYPES) {
      const vessel = getVesselAssetSet(vesselType);

      expect(vessel.vesselType).toBe(vesselType);
      expect(vessel.base).toMatchObject({
        id: `fallback.vessel-base.${vesselType}`,
        layer: 'vessel-base',
        representation: 'svg-fallback',
        source: 'deterministic-fallback',
        uri: `fallback://agent-fleet/vessel-base/${vesselType}`,
      });
    }
  });

  test('provides typed engine, beacon, selection, and completion layer refs', () => {
    const vessel = getVesselAssetSet('frigate');

    for (const state of ENGINE_STATES) {
      expect(vessel.engine[state]).toMatchObject({
        layer: 'engine',
        id: `fallback.engine.${state}`,
      });
    }
    for (const state of BEACON_STATES) {
      expect(vessel.beacon[state]).toMatchObject({
        layer: 'beacon',
        id: `fallback.beacon.${state}`,
      });
    }
    expect(vessel.selection).toMatchObject({
      id: 'fallback.selection.ring',
      layer: 'selection',
    });
    expect(vessel.completion).toMatchObject({
      id: 'fallback.completion.pulse',
      layer: 'completion',
    });
  });

  test('keeps the layer catalogue network-free and stable across vessel types', () => {
    const frigate = getVesselAssetSet('frigate');
    const recon = getVesselAssetSet('recon');
    const refs = [
      frigate.base,
      ...Object.values(frigate.engine),
      ...Object.values(frigate.beacon),
      frigate.selection,
      frigate.completion,
    ];

    expect(refs.every((ref) => ref.source === 'deterministic-fallback')).toBe(true);
    expect(refs.every((ref) => ref.representation === 'svg-fallback')).toBe(true);
    expect(refs.every((ref) => !/^https?:/i.test(ref.uri))).toBe(true);
    expect(recon.engine.active).toBe(frigate.engine.active);
    expect(recon.selection).toBe(frigate.selection);
    expect(recon.completion).toBe(frigate.completion);
  });

  test('maps every Core AgentRole without coupling vessel type to runtime', () => {
    const expected: Record<
      Parameters<typeof vesselTypeForAssetRole>[0],
      (typeof VESSEL_TYPES)[number]
    > = {
      coordinator: 'flagship',
      worker: 'frigate',
      reviewer: 'recon',
      researcher: 'recon',
      debugger: 'frigate',
      planner: 'frigate',
      tester: 'frigate',
      subagent: 'drone',
      external: 'frigate',
    };

    for (const [role, vesselType] of Object.entries(expected) as Array<
      [Parameters<typeof vesselTypeForAssetRole>[0], (typeof VESSEL_TYPES)[number]]
    >) {
      expect(vesselTypeForAssetRole(role)).toBe(vesselType);
      expect(getVesselAssetSetForRole(role)).toBe(getVesselAssetSet(vesselType));
    }
  });
});
