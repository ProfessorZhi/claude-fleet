import type { FleetRuntime } from '../../../core/src/runtimeContracts.js';

export type VesselRole =
  'coordinator' | 'worker' | 'reviewer' | 'debugger' | 'subagent' | 'external';

export type VesselType = 'flagship' | 'frigate' | 'recon' | 'drone';
export type PersistentVesselStatus =
  'starting' | 'working' | 'waiting' | 'idle' | 'error' | 'stopped';
export type EngineState = 'off' | 'idle' | 'active';
export type BeaconState = 'none' | 'waiting' | 'error';
export type MotionState = 'docked' | 'hover' | 'cruise';

export interface VesselVisualState {
  status: PersistentVesselStatus;
  vesselType: VesselType;
  runtimeBadge: 'Claude' | 'Codex' | 'Runtime' | null;
  engine: EngineState;
  beacon: BeaconState;
  motion: MotionState;
  selected: boolean;
  completionPulse: boolean;
}

export function normalizeVesselStatus(value: string | undefined): PersistentVesselStatus {
  switch (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ) {
    case 'starting':
    case 'launching':
      return 'starting';
    case 'working':
    case 'running':
    case 'active':
      return 'working';
    case 'waiting':
    case 'pending':
      return 'waiting';
    case 'error':
    case 'failed':
      return 'error';
    case 'stopped':
    case 'stop':
      return 'stopped';
    case 'idle':
    case 'ready':
    default:
      return 'idle';
  }
}

export function vesselTypeForRole(role: VesselRole): VesselType {
  switch (role) {
    case 'coordinator':
      return 'flagship';
    case 'reviewer':
      return 'recon';
    case 'subagent':
      return 'drone';
    case 'worker':
    case 'debugger':
    case 'external':
      return 'frigate';
  }
}

function runtimeBadgeFor(
  runtime: FleetRuntime | string | undefined,
): VesselVisualState['runtimeBadge'] {
  switch (runtime) {
    case 'claude-code':
      return 'Claude';
    case 'codex-cli':
      return 'Codex';
    case 'other':
      return 'Runtime';
    case undefined:
      return null;
    default:
      return 'Runtime';
  }
}

export function buildVesselVisualState(input: {
  role: VesselRole;
  status?: string;
  runtime?: FleetRuntime | string;
  selected?: boolean;
  completionPulse?: boolean;
}): VesselVisualState {
  const status = normalizeVesselStatus(input.status);
  const common = {
    status,
    vesselType: vesselTypeForRole(input.role),
    runtimeBadge: runtimeBadgeFor(input.runtime),
    selected: input.selected ?? false,
    completionPulse: input.completionPulse ?? false,
  };

  switch (status) {
    case 'starting':
      return { ...common, engine: 'active', beacon: 'none', motion: 'docked' };
    case 'working':
      return { ...common, engine: 'active', beacon: 'none', motion: 'cruise' };
    case 'waiting':
      return { ...common, engine: 'idle', beacon: 'waiting', motion: 'hover' };
    case 'error':
      return { ...common, engine: 'off', beacon: 'error', motion: 'hover' };
    case 'stopped':
      return { ...common, engine: 'off', beacon: 'none', motion: 'docked' };
    case 'idle':
      return { ...common, engine: 'idle', beacon: 'none', motion: 'hover' };
  }
}
