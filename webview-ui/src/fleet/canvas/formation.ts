import { vesselTypeForRole } from '../visualState.js';
import type {
  FleetFormationLayout,
  FormationGroup,
  FormationHitbox,
  FormationLayoutOptions,
  FormationNode,
  FormationPoint,
  FormationRect,
  FormationSlotAllocation,
  FormationSlotState,
  FormationVessel,
} from './types.js';

export const DEFAULT_FORMATION_COLUMNS = 5;
export const DEFAULT_FORMATION_SLOT_COUNT = 20;

const ROLE_ORDER: Record<FormationVessel['role'], number> = {
  coordinator: 0,
  reviewer: 1,
  worker: 2,
  debugger: 3,
  external: 4,
  subagent: 5,
};

function compareValues(left: string | number, right: string | number): number {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function formationKey(vessel: FormationVessel): string {
  return vessel.key ?? `${vessel.repo || 'unassigned'}::${vessel.id}`;
}

export function compareFormationVessels(left: FormationVessel, right: FormationVessel): number {
  return (
    (ROLE_ORDER[left.role] ?? Number.MAX_SAFE_INTEGER) -
      (ROLE_ORDER[right.role] ?? Number.MAX_SAFE_INTEGER) ||
    compareValues(left.repo, right.repo) ||
    compareValues(left.id, right.id)
  );
}

function isValidSlot(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function firstFreeSlot(occupied: Set<number>): number {
  let slot = 0;
  while (occupied.has(slot)) slot += 1;
  return slot;
}

/**
 * Assigns slots without using array indexes as identity. Existing keys keep
 * their slot when the roster is reordered or new vessels join the formation.
 */
export function assignFormationSlots(
  vessels: readonly FormationVessel[],
  previous: FormationSlotState | Readonly<Record<string, number>> = { assignments: {} },
): FormationSlotAllocation {
  const previousAssignments: Readonly<Record<string, number>> =
    'assignments' in previous
      ? (previous as FormationSlotState).assignments
      : (previous as Readonly<Record<string, number>>);
  const uniqueVessels = new Map<string, FormationVessel>();
  for (const vessel of vessels) uniqueVessels.set(formationKey(vessel), vessel);

  const assignments: Record<string, number> = {};
  const occupied = new Set<number>();
  const pending: FormationVessel[] = [];

  for (const [key, vessel] of uniqueVessels) {
    const persistedSlot = previousAssignments[key];
    const requestedSlot = isValidSlot(persistedSlot) ? persistedSlot : vessel.preferredSlot;
    if (isValidSlot(requestedSlot) && !occupied.has(requestedSlot)) {
      assignments[key] = requestedSlot;
      occupied.add(requestedSlot);
    } else {
      pending.push(vessel);
    }
  }

  pending.sort(compareFormationVessels);
  for (const vessel of pending) {
    const key = formationKey(vessel);
    const slot = firstFreeSlot(occupied);
    assignments[key] = slot;
    occupied.add(slot);
  }

  const liveKeys = new Set(uniqueVessels.keys());
  const releasedSlots = Object.entries(previousAssignments)
    .filter(([key]) => !liveKeys.has(key))
    .map(([, slot]) => slot)
    .filter(isValidSlot)
    .sort((left, right) => left - right);

  return {
    assignments,
    state: { assignments },
    releasedSlots,
  };
}

function stableGroupOrder(left: FormationGroup, right: FormationGroup): number {
  return compareValues(left.key, right.key);
}

function buildGroups(
  vessels: readonly FormationVessel[],
  keyOf: (vessel: FormationVessel) => string,
  labelOf: (vessel: FormationVessel) => string,
): FormationGroup[] {
  const grouped = new Map<string, FormationVessel[]>();
  for (const vessel of vessels) {
    const key = keyOf(vessel);
    const group = grouped.get(key) ?? [];
    group.push(vessel);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .map(([key, group]) => ({
      key,
      label: labelOf(group[0] as FormationVessel),
      vesselKeys: group.sort(compareFormationVessels).map(formationKey),
      bounds: null,
    }))
    .sort(stableGroupOrder);
}

export function groupVesselsByRepo(vessels: readonly FormationVessel[]): FormationGroup[] {
  return buildGroups(
    vessels,
    (vessel) => vessel.repo || 'unassigned',
    (vessel) => vessel.repo || 'Unassigned repo',
  );
}

export function groupVesselsByRole(vessels: readonly FormationVessel[]): FormationGroup[] {
  return buildGroups(
    vessels,
    (vessel) => vessel.role,
    (vessel) => vessel.role,
  ).sort(
    (left, right) =>
      (ROLE_ORDER[left.key as FormationVessel['role']] ?? 99) -
      (ROLE_ORDER[right.key as FormationVessel['role']] ?? 99),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, Number.isFinite(width) ? width : 1),
    height: Math.max(1, Number.isFinite(height) ? height : 1),
  };
}

function slotCell(slot: number, columns: number): { row: number; column: number } {
  if (slot === 0) return { row: 0, column: Math.floor(columns / 2) };
  const offset = slot - 1;
  return { row: Math.floor(offset / columns) + 1, column: offset % columns };
}

function rectAround(point: FormationPoint, radius: number): FormationHitbox {
  return {
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2,
    radius,
  };
}

function unionRect(rectangles: readonly FormationRect[]): FormationRect | null {
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map((rect) => rect.x));
  const top = Math.min(...rectangles.map((rect) => rect.y));
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expandRect(rect: FormationRect | null, padding: number): FormationRect | null {
  if (!rect) return null;
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function attachGroupBounds(
  groups: FormationGroup[],
  nodes: readonly FormationNode[],
  groupPadding: number,
): FormationGroup[] {
  const nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  return groups.map((group) => ({
    ...group,
    bounds: expandRect(
      unionRect(
        group.vesselKeys
          .map((key) => nodesByKey.get(key)?.hitbox)
          .filter((hitbox): hitbox is FormationHitbox => hitbox !== undefined),
      ),
      groupPadding,
    ),
  }));
}

export function computeFleetFormation(
  vessels: readonly FormationVessel[],
  viewport: { width: number; height: number },
  previousSlots: FormationSlotState | Readonly<Record<string, number>> = { assignments: {} },
  options: FormationLayoutOptions = {},
): FleetFormationLayout {
  const size = normalizeViewport(viewport.width, viewport.height);
  const columns = clamp(Math.round(options.columns ?? DEFAULT_FORMATION_COLUMNS), 3, 8);
  const allocation = assignFormationSlots(vessels, previousSlots);
  const maxSlot = Math.max(-1, ...Object.values(allocation.assignments));
  const rows = Math.max(2, 1 + Math.ceil(Math.max(0, maxSlot) / columns));
  const padding = Math.max(0, options.padding ?? 28);
  const groupPadding = Math.max(0, options.groupPadding ?? 18);
  const cellWidth = Math.max(1, (size.width - padding * 2) / columns);
  const cellHeight = Math.max(1, (size.height - padding * 2) / rows);
  const defaultRadius = clamp(Math.min(cellWidth, cellHeight) * 0.28, 18, 48);
  const hitRadius = Math.max(12, options.hitRadius ?? defaultRadius);

  const nodes = [...vessels]
    .map((vessel) => {
      const key = formationKey(vessel);
      const slot = allocation.assignments[key] as number;
      const { row, column } = slotCell(slot, columns);
      const position = {
        x: padding + cellWidth * (column + 0.5),
        y: padding + cellHeight * (row + 0.5),
      };
      return {
        key,
        vessel,
        vesselType: vesselTypeForRole(vessel.role),
        slot,
        row,
        column,
        position,
        hitbox: rectAround(position, hitRadius),
        repoGroup: vessel.repo || 'unassigned',
        roleGroup: vessel.role,
      } satisfies FormationNode;
    })
    .sort((left, right) => left.slot - right.slot || compareValues(left.key, right.key));

  const repoGroups = attachGroupBounds(groupVesselsByRepo(vessels), nodes, groupPadding);
  const roleGroups = attachGroupBounds(groupVesselsByRole(vessels), nodes, groupPadding);

  return {
    viewport: size,
    columns,
    rows,
    nodes,
    repoGroups,
    roleGroups,
    slots: allocation.state,
  };
}

export function pointInFormationHitbox(point: FormationPoint, hitbox: FormationHitbox): boolean {
  return (
    point.x >= hitbox.x &&
    point.x <= hitbox.x + hitbox.width &&
    point.y >= hitbox.y &&
    point.y <= hitbox.y + hitbox.height
  );
}

export function hitTestFleetFormation(
  point: FormationPoint,
  layout: FleetFormationLayout,
): FormationNode | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index];
    if (node && pointInFormationHitbox(point, node.hitbox)) return node;
  }
  return null;
}
