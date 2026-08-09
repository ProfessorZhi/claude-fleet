/**
 * Secret-free identity shared by Fleet Controller, runtime adapters and
 * agentmetrics. Wire representations use snake_case; TypeScript callers use
 * camelCase through this type.
 */

export interface FleetIdentity {
  fleetRunId?: string;
  fleetTaskId?: string;
  fleetWorkerId?: string;
  fleetCoordinatorId?: string;
  parentWorkerId?: string;
  workerRole?: string;
  worktreeId?: string;
  attempt?: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Return a user-facing validation error, or null when the identity is valid. */
export function validateFleetIdentity(identity: FleetIdentity | undefined): string | null {
  if (!identity) return null;

  const fields: Array<[keyof FleetIdentity, string | undefined]> = [
    ['fleetRunId', identity.fleetRunId],
    ['fleetTaskId', identity.fleetTaskId],
    ['fleetWorkerId', identity.fleetWorkerId],
    ['fleetCoordinatorId', identity.fleetCoordinatorId],
    ['parentWorkerId', identity.parentWorkerId],
    ['worktreeId', identity.worktreeId],
  ];
  for (const [field, value] of fields) {
    if (value !== undefined && !isSafeId(value)) {
      return `Fleet identity field '${field}' must be a safe identifier.`;
    }
  }
  if (identity.workerRole !== undefined) {
    if (
      identity.workerRole.length === 0 ||
      identity.workerRole.length > 128 ||
      /[\r\n]/.test(identity.workerRole)
    ) {
      return "Fleet identity field 'workerRole' must be a non-empty single-line string.";
    }
  }
  if (
    identity.attempt !== undefined &&
    (!Number.isInteger(identity.attempt) || identity.attempt < 1)
  ) {
    return "Fleet identity field 'attempt' must be a positive integer.";
  }
  return null;
}

/** Convert the TypeScript identity to the snake_case JSON boundary. */
export function toFleetWireIdentity(
  identity: FleetIdentity | undefined,
): Record<string, unknown> | undefined {
  if (!identity) return undefined;
  const wire: Record<string, unknown> = {};
  const mappings: Array<[keyof FleetIdentity, string]> = [
    ['fleetRunId', 'fleet_run_id'],
    ['fleetTaskId', 'fleet_task_id'],
    ['fleetWorkerId', 'fleet_worker_id'],
    ['fleetCoordinatorId', 'fleet_coordinator_id'],
    ['parentWorkerId', 'parent_worker_id'],
    ['workerRole', 'worker_role'],
    ['worktreeId', 'worktree_id'],
    ['attempt', 'attempt'],
  ];
  for (const [source, target] of mappings) {
    const value = identity[source];
    if (value !== undefined) wire[target] = value;
  }
  return Object.keys(wire).length > 0 ? wire : undefined;
}
