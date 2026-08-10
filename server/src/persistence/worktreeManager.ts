import type {
  WorktreeConflict,
  WorktreeConflictCheck,
  WorktreeConflictCheckRequest,
  WorktreeCreateRequest,
  WorktreeManager,
  WorktreeRecord,
} from '../../../core/src/runtimeContracts.js';
import { FleetLedgerStore } from '../fleetLedgerStore.js';
import {
  validateWorktreeId,
  type WorktreeProvisioner,
  type WorktreeReleaseRequest,
} from './worktreeProvisioner.js';

export type { WorktreeProvisioner, WorktreeReleaseRequest } from './worktreeProvisioner.js';

export class WorktreeConflictError extends Error {
  constructor(readonly check: WorktreeConflictCheck) {
    super('Worktree conflicts with an existing active worktree.');
    this.name = 'WorktreeConflictError';
  }
}

/**
 * Ledger-backed ownership registry. Real Git provisioning is deliberately an
 * injected boundary so tests and hosts can choose a safe implementation.
 */
export class LedgerWorktreeManager implements WorktreeManager {
  constructor(
    private readonly ledger: FleetLedgerStore,
    private readonly provisioner?: WorktreeProvisioner,
  ) {}

  async checkConflict(request: WorktreeConflictCheckRequest): Promise<WorktreeConflictCheck> {
    const conflicts: WorktreeConflict[] = [];
    for (const record of this.ledger.listWorktrees()) {
      if (record.status === 'released') continue;
      if (record.worktreeId === request.worktreeId) continue;
      if (
        request.workItemId &&
        record.workItemId === request.workItemId &&
        samePath(record.worktreePath, request.worktreePath)
      ) {
        continue;
      }
      if (
        request.instanceId &&
        record.instanceId === request.instanceId &&
        samePath(record.worktreePath, request.worktreePath)
      ) {
        continue;
      }
      if (!samePath(record.repo, request.repo)) continue;

      if (samePath(record.worktreePath, request.worktreePath)) {
        conflicts.push({
          worktreeId: record.worktreeId,
          reason: 'path',
          worktreePath: record.worktreePath,
          branch: record.branch,
        });
      }
      if (request.branch && record.branch === request.branch) {
        conflicts.push({
          worktreeId: record.worktreeId,
          reason: 'branch',
          worktreePath: record.worktreePath,
          branch: record.branch,
        });
      }
    }

    return { conflict: conflicts.length > 0, conflicts };
  }

  async create(request: WorktreeCreateRequest): Promise<WorktreeRecord> {
    const check = await this.checkConflict(request);
    if (check.conflict) throw new WorktreeConflictError(check);

    const provisioned = (await this.provisioner?.create(request)) ?? {};
    const record: WorktreeRecord = {
      ...request,
      worktreePath: provisioned.worktreePath ?? request.worktreePath,
      branch: provisioned.branch ?? request.branch,
      status: 'active',
    };
    try {
      await this.record(record);
    } catch (error) {
      const rollback = this.provisioner?.release?.({ ...record, force: true });
      if (rollback) await rollback.catch(() => undefined);
      throw error;
    }
    return clone(record);
  }

  /** Release the Git worktree when a provisioner is configured, then mark it released. */
  async release(worktreeId: string, force = false): Promise<WorktreeRecord> {
    const record = this.ledger.getWorktree(worktreeId);
    if (!record) throw new Error(`Unknown worktree: ${worktreeId}`);
    if (record.status === 'released') return clone(record);

    const releaseRequest: WorktreeReleaseRequest = { ...record, force };
    await this.provisioner?.release?.(releaseRequest);
    const released: WorktreeRecord = {
      ...record,
      status: 'released',
      releasedAt: Date.now(),
    };
    await this.record(released);
    return clone(released);
  }

  async cleanup(worktreeId: string, force = false): Promise<WorktreeRecord> {
    return this.release(worktreeId, force);
  }

  async record(record: WorktreeRecord): Promise<void> {
    validateWorktreeId(record.worktreeId);
    if (!record.repo.trim()) throw new Error('Worktree records require repo.');
    if (!record.worktreePath.trim()) throw new Error('Worktree records require worktreePath.');
    this.ledger.upsertWorktree(record);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}
