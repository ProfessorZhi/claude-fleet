import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  AgentPerformanceAggregate,
  AssignmentDecision,
  ControlDecisionRecord,
  LaunchRecord,
  MissionRecord,
  QualitySignal,
  QuotaSnapshot,
  ResourceAccount,
  SessionRecord,
  UsageRecord,
  WorkItemRecord,
} from '../../../core/src/ledgerContracts.js';
import { validateLedgerPayload } from '../../../core/src/ledgerContracts.js';
import type { WorktreeRecord } from '../../../core/src/runtimeContracts.js';

export const FLEET_LEDGER_SNAPSHOT_SCHEMA = 'claude-fleet.ledger' as const;
export const FLEET_LEDGER_SNAPSHOT_VERSION = 1 as const;

const SNAPSHOT_ARRAY_KEYS = [
  'missions',
  'workItems',
  'sessions',
  'launches',
  'usage',
  'quotas',
  'quality',
  'assignments',
  'controlDecisions',
  'performance',
  'resources',
  'worktrees',
] as const;

type SnapshotArrayKey = (typeof SNAPSHOT_ARRAY_KEYS)[number];

const SNAPSHOT_ID_KEYS: Record<SnapshotArrayKey, string> = {
  missions: 'missionId',
  workItems: 'workItemId',
  sessions: 'sessionId',
  launches: 'launchId',
  usage: 'usageId',
  quotas: 'snapshotId',
  quality: 'signalId',
  assignments: 'decisionId',
  controlDecisions: 'decisionId',
  performance: 'aggregateId',
  resources: 'resourceAccountId',
  worktrees: 'worktreeId',
};

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;

export interface FleetLedgerSnapshot {
  /** Stable discriminator for the persisted document. Optional for v1 legacy files. */
  schema?: typeof FLEET_LEDGER_SNAPSHOT_SCHEMA;
  version: typeof FLEET_LEDGER_SNAPSHOT_VERSION;
  /** Monotonically increasing committed revision used for optimistic writes. */
  revision?: number;
  missions: MissionRecord[];
  workItems: WorkItemRecord[];
  sessions: SessionRecord[];
  launches: LaunchRecord[];
  usage: UsageRecord[];
  quotas: QuotaSnapshot[];
  quality: QualitySignal[];
  assignments: AssignmentDecision[];
  controlDecisions: ControlDecisionRecord[];
  performance: AgentPerformanceAggregate[];
  resources: ResourceAccount[];
  worktrees: WorktreeRecord[];
}

/**
 * Synchronous on purpose: FleetLedgerStore has a synchronous metadata API and
 * callers must observe one committed snapshot per mutation.
 */
export interface FleetSnapshotPersistence {
  load(): FleetLedgerSnapshot | undefined;
  save(snapshot: FleetLedgerSnapshot, options?: FleetSnapshotSaveOptions): void;
}

export interface FleetSnapshotSaveOptions {
  /** Revision observed by the writer before it produced this candidate snapshot. */
  expectedRevision?: number;
}

export class FleetSnapshotCorruptionError extends Error {
  readonly code = 'FLEET_SNAPSHOT_CORRUPT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FleetSnapshotCorruptionError';
  }
}

export class FleetSnapshotConflictError extends Error {
  readonly code = 'FLEET_SNAPSHOT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'FleetSnapshotConflictError';
  }
}

export class FleetSnapshotLockTimeoutError extends Error {
  readonly code = 'FLEET_SNAPSHOT_LOCK_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'FleetSnapshotLockTimeoutError';
  }
}

export function emptyFleetLedgerSnapshot(): FleetLedgerSnapshot {
  return {
    schema: FLEET_LEDGER_SNAPSHOT_SCHEMA,
    version: FLEET_LEDGER_SNAPSHOT_VERSION,
    revision: 0,
    missions: [],
    workItems: [],
    sessions: [],
    launches: [],
    usage: [],
    quotas: [],
    quality: [],
    assignments: [],
    controlDecisions: [],
    performance: [],
    resources: [],
    worktrees: [],
  };
}

/** Useful for tests and embedding the ledger in another local host. */
export class InMemoryFleetSnapshotPersistence implements FleetSnapshotPersistence {
  private snapshotValue: FleetLedgerSnapshot | undefined;

  constructor(initial?: FleetLedgerSnapshot) {
    if (initial) {
      assertSnapshotSafe(initial);
      this.snapshotValue = cloneSnapshot(normalizeSnapshot(initial));
    }
  }

  load(): FleetLedgerSnapshot | undefined {
    return this.snapshotValue ? cloneSnapshot(this.snapshotValue) : undefined;
  }

  save(snapshot: FleetLedgerSnapshot, options: FleetSnapshotSaveOptions = {}): void {
    assertSnapshotSafe(snapshot);
    const currentRevision = this.snapshotValue?.revision ?? 0;
    const expectedRevision = options.expectedRevision ?? currentRevision;
    const nextRevision =
      options.expectedRevision === undefined
        ? currentRevision + 1
        : (snapshot.revision ?? currentRevision + 1);
    if (expectedRevision !== currentRevision || nextRevision !== currentRevision + 1) {
      throw new FleetSnapshotConflictError(
        `Fleet ledger snapshot revision conflict: expected ${expectedRevision}, current ${currentRevision}.`,
      );
    }
    this.snapshotValue = cloneSnapshot(normalizeSnapshot({ ...snapshot, revision: nextRevision }));
  }
}

/**
 * Small local JSON backend. It persists only the bounded, validated ledger
 * snapshot; it never accepts transcripts, prompts, secrets, or environment
 * snapshots.
 */
export class JsonFileFleetSnapshotPersistence implements FleetSnapshotPersistence {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLockMs: number;

  constructor(
    private readonly filePath: string,
    options: JsonFileFleetSnapshotPersistenceOptions = {},
  ) {
    this.lockPath = `${filePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  load(): FleetLedgerSnapshot | undefined {
    if (!existsSync(this.filePath)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new FleetSnapshotCorruptionError(
        'Fleet ledger snapshot is not valid JSON; refusing to recover from it.',
        { cause: error },
      );
    }
    try {
      assertSnapshotSafe(parsed);
    } catch (error) {
      throw new FleetSnapshotCorruptionError(
        'Fleet ledger snapshot failed schema or safety validation; refusing to recover from it.',
        { cause: error },
      );
    }
    return cloneSnapshot(normalizeSnapshot(parsed));
  }

  save(snapshot: FleetLedgerSnapshot, options: FleetSnapshotSaveOptions = {}): void {
    assertSnapshotSafe(snapshot);
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });

    const lock = this.acquireWriterLock();
    let temporaryPath: string | undefined;
    try {
      const current = this.loadForWrite();
      const currentRevision = current?.revision ?? 0;
      const expectedRevision = options.expectedRevision ?? currentRevision;
      const nextRevision =
        options.expectedRevision === undefined
          ? currentRevision + 1
          : (snapshot.revision ?? currentRevision + 1);
      if (expectedRevision !== currentRevision || nextRevision !== currentRevision + 1) {
        throw new FleetSnapshotConflictError(
          `Fleet ledger snapshot revision conflict: expected ${expectedRevision}, current ${currentRevision}.`,
        );
      }

      const committed = normalizeSnapshot({ ...snapshot, revision: nextRevision });
      temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(committed, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      // Windows rejects fsync on a read-only descriptor; keep the descriptor
      // writable even though the contents are already fully written.
      const temporaryHandle = openSync(temporaryPath, 'r+');
      try {
        fsyncSync(temporaryHandle);
      } finally {
        closeSync(temporaryHandle);
      }

      // Both POSIX rename(2) and Windows MoveFileEx replace the destination
      // when the temp file is in the same directory. Readers therefore see
      // either the old complete JSON or the new complete JSON, never a partial
      // write. The writer lock also serializes the revision check and replace.
      renameSync(temporaryPath, this.filePath);
      temporaryPath = undefined;
    } finally {
      if (temporaryPath) rmSync(temporaryPath, { force: true });
      this.releaseWriterLock(lock);
    }
  }

  private loadForWrite(): FleetLedgerSnapshot | undefined {
    if (!existsSync(this.filePath)) return undefined;
    return this.load();
  }

  private acquireWriterLock(): FleetWriterLock {
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = openSync(this.lockPath, 'wx', 0o600);
        const token = randomUUID();
        try {
          writeFileSync(
            handle,
            JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
            'utf8',
          );
          return { handle, token };
        } catch (writeError) {
          closeSync(handle);
          rmSync(this.lockPath, { force: true });
          throw writeError;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        if (this.isStaleLock()) {
          rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new FleetSnapshotLockTimeoutError(
            `Timed out waiting for Fleet ledger writer lock: ${this.lockPath}`,
          );
        }
        sleepSync(this.lockRetryMs);
      }
    }
  }

  private isStaleLock(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs >= this.staleLockMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private releaseWriterLock(lock: FleetWriterLock): void {
    try {
      closeSync(lock.handle);
    } finally {
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: unknown };
        if (owner.token === lock.token) rmSync(this.lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
}

export interface JsonFileFleetSnapshotPersistenceOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
}

interface FleetWriterLock {
  handle: number;
  token: string;
}

export function assertSnapshotSafe(snapshot: unknown): asserts snapshot is FleetLedgerSnapshot {
  assertSnapshotShape(snapshot);
  const errors = validateLedgerPayload(snapshot);
  if (errors.length > 0) throw new Error(errors[0]);
}

function assertSnapshotShape(snapshot: unknown): asserts snapshot is FleetLedgerSnapshot {
  if (!isRecord(snapshot) || snapshot.version !== FLEET_LEDGER_SNAPSHOT_VERSION) {
    throw new Error('Unsupported or malformed Fleet ledger snapshot version.');
  }
  if (snapshot.schema !== undefined && snapshot.schema !== FLEET_LEDGER_SNAPSHOT_SCHEMA) {
    throw new Error('Unsupported Fleet ledger snapshot schema.');
  }
  const revision = snapshot.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    throw new Error('Fleet ledger snapshot revision must be a non-negative integer.');
  }
  const allowedKeys = new Set<string>(['schema', 'version', 'revision', ...SNAPSHOT_ARRAY_KEYS]);
  for (const key of Object.keys(snapshot)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported Fleet ledger snapshot field: ${key}.`);
    }
  }
  for (const key of SNAPSHOT_ARRAY_KEYS) {
    if (!Array.isArray(snapshot[key])) {
      throw new Error('Fleet ledger snapshot field ' + key + ' must be an array.');
    }
    const seenIds = new Set<string>();
    for (const record of snapshot[key]) {
      if (!isRecord(record)) {
        throw new Error(`Fleet ledger snapshot field ${key} contains a non-record item.`);
      }
      const id = record[SNAPSHOT_ID_KEYS[key]];
      if (typeof id !== 'string' || !id.trim() || seenIds.has(id)) {
        throw new Error(`Fleet ledger snapshot field ${key} contains an invalid or duplicate id.`);
      }
      seenIds.add(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSnapshot(snapshot: FleetLedgerSnapshot): FleetLedgerSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as FleetLedgerSnapshot;
}

function normalizeSnapshot(snapshot: FleetLedgerSnapshot): FleetLedgerSnapshot {
  return {
    ...snapshot,
    schema: FLEET_LEDGER_SNAPSHOT_SCHEMA,
    revision: snapshot.revision ?? 0,
  };
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}
