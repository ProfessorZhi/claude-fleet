import type { VesselRole, VesselType } from '../visualState.js';

export type FormationId = string | number;

export interface FormationVessel {
  id: FormationId;
  /** Optional stable key when the same id can exist in more than one repo. */
  key?: string;
  repo: string;
  role: VesselRole;
  status?: string;
  runtime?: string;
  label?: string;
  completionPulse?: boolean;
  completionPulseProgress?: number;
  droneCount?: number;
  /** A persisted slot wins over first-run ordering. */
  preferredSlot?: number;
}

export interface FormationPoint {
  x: number;
  y: number;
}

export interface FormationSize {
  width: number;
  height: number;
}

export interface FormationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormationHitbox extends FormationRect {
  radius: number;
}

export interface FormationNode {
  key: string;
  vessel: FormationVessel;
  vesselType: VesselType;
  slot: number;
  row: number;
  column: number;
  position: FormationPoint;
  hitbox: FormationHitbox;
  repoGroup: string;
  roleGroup: VesselRole;
}

export interface FormationGroup {
  key: string;
  label: string;
  vesselKeys: string[];
  bounds: FormationRect | null;
}

export interface FormationSlotState {
  assignments: Record<string, number>;
}

export interface FormationSlotAllocation {
  assignments: Record<string, number>;
  state: FormationSlotState;
  releasedSlots: number[];
}

export interface FleetFormationLayout {
  viewport: FormationSize;
  columns: number;
  rows: number;
  nodes: FormationNode[];
  repoGroups: FormationGroup[];
  roleGroups: FormationGroup[];
  slots: FormationSlotState;
}

export interface FormationLayoutOptions {
  columns?: number;
  padding?: number;
  hitRadius?: number;
  groupPadding?: number;
}

export interface FormationPointHitTestOptions {
  includeStopped?: boolean;
}
