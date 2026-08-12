import type { AgentRole } from '../../../../core/src/runtimeContracts.js';
import type { BeaconState, EngineState, VesselType } from '../visualState.js';

/**
 * The renderer-facing identity of an asset. `uri` is deliberately a logical
 * fallback URI rather than a file path or network URL. A future sprite loader
 * can resolve the same ids without changing the scene model or vessel roles.
 */
export interface FleetAssetRef {
  readonly id: string;
  readonly layer: FleetAssetLayer;
  readonly representation: 'svg-fallback';
  readonly source: 'deterministic-fallback';
  readonly uri: string;
}

export type FleetAssetLayer = 'vessel-base' | 'engine' | 'beacon' | 'selection' | 'completion';

export interface VesselAssetSet {
  readonly vesselType: VesselType;
  readonly base: FleetAssetRef;
  readonly engine: Readonly<Record<EngineState, FleetAssetRef>>;
  readonly beacon: Readonly<Record<BeaconState, FleetAssetRef>>;
  readonly selection: FleetAssetRef;
  readonly completion: FleetAssetRef;
}

export interface FleetAssetManifest {
  readonly version: 1;
  readonly source: 'deterministic-fallback';
  readonly vessels: Readonly<Record<VesselType, VesselAssetSet>>;
}

const FALLBACK_URI_PREFIX = 'fallback://agent-fleet';

function fallbackAsset(layer: FleetAssetLayer, name: string): FleetAssetRef {
  const id = `fallback.${layer}.${name}`;
  return {
    id,
    layer,
    representation: 'svg-fallback',
    source: 'deterministic-fallback',
    uri: `${FALLBACK_URI_PREFIX}/${layer}/${name}`,
  };
}

const ENGINE_ASSETS: Readonly<Record<EngineState, FleetAssetRef>> = {
  off: fallbackAsset('engine', 'off'),
  idle: fallbackAsset('engine', 'idle'),
  active: fallbackAsset('engine', 'active'),
};

const BEACON_ASSETS: Readonly<Record<BeaconState, FleetAssetRef>> = {
  none: fallbackAsset('beacon', 'none'),
  waiting: fallbackAsset('beacon', 'waiting'),
  error: fallbackAsset('beacon', 'error'),
};

const SELECTION_ASSET = fallbackAsset('selection', 'ring');
const COMPLETION_ASSET = fallbackAsset('completion', 'pulse');

function vesselAssetSet(vesselType: VesselType): VesselAssetSet {
  return {
    vesselType,
    base: fallbackAsset('vessel-base', vesselType),
    engine: ENGINE_ASSETS,
    beacon: BEACON_ASSETS,
    selection: SELECTION_ASSET,
    completion: COMPLETION_ASSET,
  };
}

/**
 * The complete first-generation fallback catalogue. The base hull changes
 * with role-derived vessel type; runtime and status are separate layers.
 */
export const FLEET_ASSET_MANIFEST: FleetAssetManifest = {
  version: 1,
  source: 'deterministic-fallback',
  vessels: {
    flagship: vesselAssetSet('flagship'),
    frigate: vesselAssetSet('frigate'),
    recon: vesselAssetSet('recon'),
    drone: vesselAssetSet('drone'),
  },
};

/**
 * Keeps the role-to-vessel contract in one place while leaving runtime
 * identity (Claude, Codex, or another adapter) to a separate badge layer.
 */
export function vesselTypeForAssetRole(role: AgentRole): VesselType {
  switch (role) {
    case 'coordinator':
      return 'flagship';
    case 'reviewer':
    case 'researcher':
      return 'recon';
    case 'subagent':
      return 'drone';
    case 'worker':
    case 'debugger':
    case 'planner':
    case 'tester':
    case 'external':
      return 'frigate';
  }
}

export function getVesselAssetSet(vesselType: VesselType): VesselAssetSet {
  return FLEET_ASSET_MANIFEST.vessels[vesselType];
}

export function getVesselAssetSetForRole(role: AgentRole): VesselAssetSet {
  return getVesselAssetSet(vesselTypeForAssetRole(role));
}
