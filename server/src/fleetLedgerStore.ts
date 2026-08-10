import {
  type AgentPerformanceAggregate,
  type AssignmentDecision,
  type ControlDecisionRecord,
  type LaunchRecord,
  type MissionRecord,
  type QualitySignal,
  type QuotaSnapshot,
  type ResourceAccount,
  type SessionRecord,
  type UsageRecord,
  validateLedgerPayload,
  type WorkItemRecord,
} from '../../core/src/ledgerContracts.js';
import type { WorktreeRecord } from '../../core/src/runtimeContracts.js';
import {
  assertSnapshotSafe,
  FLEET_LEDGER_SNAPSHOT_SCHEMA,
  FLEET_LEDGER_SNAPSHOT_VERSION,
  type FleetLedgerSnapshot,
  type FleetSnapshotPersistence,
} from './persistence/fleetSnapshotPersistence.js';

export interface FleetLedgerStoreOptions {
  persistence?: FleetSnapshotPersistence;
  snapshot?: FleetLedgerSnapshot;
}

/**
 * Small in-memory ledger for the management plane.
 *
 * The ledger stores bounded, secret-free metadata only. It intentionally does
 * not persist transcripts, run scheduling, spawn runtimes, or act as a cloud
 * database. An optional local snapshot adapter can persist the same bounded
 * metadata without changing the default in-memory behavior.
 */
export class FleetLedgerStore {
  private readonly missions = new Map<string, MissionRecord>();
  private readonly workItems = new Map<string, WorkItemRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly usage = new Map<string, UsageRecord>();
  private readonly quotas = new Map<string, QuotaSnapshot>();
  private readonly quality = new Map<string, QualitySignal>();
  private readonly assignments = new Map<string, AssignmentDecision>();
  private readonly controlDecisions = new Map<string, ControlDecisionRecord>();
  private readonly performance = new Map<string, AgentPerformanceAggregate>();
  private readonly resources = new Map<string, ResourceAccount>();
  private readonly worktrees = new Map<string, WorktreeRecord>();
  private readonly persistence?: FleetSnapshotPersistence;
  private revision = 0;

  constructor(options: FleetLedgerStoreOptions = {}) {
    this.persistence = options.persistence;
    const snapshot = options.snapshot ?? this.persistence?.load();
    if (snapshot) {
      this.revision = snapshot.revision ?? 0;
      this.restore(snapshot);
    }
  }

  upsertMission(record: MissionRecord): void {
    this.put(this.missions, record.missionId, record);
  }

  getMission(missionId: string): MissionRecord | undefined {
    return this.read(this.missions.get(missionId));
  }

  listMissions(): MissionRecord[] {
    return this.list(this.missions);
  }

  upsertWorkItem(record: WorkItemRecord): void {
    this.put(this.workItems, record.workItemId, record);
  }

  getWorkItem(workItemId: string): WorkItemRecord | undefined {
    return this.read(this.workItems.get(workItemId));
  }

  listWorkItems(missionId?: string): WorkItemRecord[] {
    return this.list(this.workItems).filter(
      (record) => !missionId || record.missionId === missionId,
    );
  }

  upsertSession(record: SessionRecord): void {
    this.put(this.sessions, record.sessionId, record);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.read(this.sessions.get(sessionId));
  }

  listSessions(instanceId?: string, workItemId?: string): SessionRecord[] {
    return this.list(this.sessions).filter(
      (record) =>
        (!instanceId || record.instanceId === instanceId) &&
        (!workItemId || record.workItemId === workItemId),
    );
  }

  recordLaunch(record: LaunchRecord): void {
    this.put(this.launches, record.launchId, record);
  }

  getLaunch(launchId: string): LaunchRecord | undefined {
    return this.read(this.launches.get(launchId));
  }

  listLaunches(instanceId?: string): LaunchRecord[] {
    return this.list(this.launches).filter(
      (record) => !instanceId || record.instanceId === instanceId,
    );
  }

  recordUsage(record: UsageRecord): void {
    this.put(this.usage, record.usageId, record);
  }

  listUsage(instanceId?: string, workItemId?: string): UsageRecord[] {
    return this.list(this.usage).filter(
      (record) =>
        (!instanceId || record.instanceId === instanceId) &&
        (!workItemId || record.workItemId === workItemId),
    );
  }

  recordQuota(record: QuotaSnapshot): void {
    this.put(this.quotas, record.snapshotId, record);
  }

  listQuota(resourceAccountId?: string): QuotaSnapshot[] {
    return this.list(this.quotas).filter(
      (record) => !resourceAccountId || record.resourceAccountId === resourceAccountId,
    );
  }

  recordQuality(record: QualitySignal): void {
    this.put(this.quality, record.signalId, record);
  }

  listQuality(workItemId?: string): QualitySignal[] {
    return this.list(this.quality).filter(
      (record) => !workItemId || record.workItemId === workItemId,
    );
  }

  recordAssignment(record: AssignmentDecision): void {
    this.put(this.assignments, record.decisionId, record);
  }

  listAssignments(workItemId?: string): AssignmentDecision[] {
    return this.list(this.assignments).filter(
      (record) => !workItemId || record.workItemId === workItemId,
    );
  }

  recordControlDecision(record: ControlDecisionRecord): void {
    this.put(this.controlDecisions, record.decisionId, record);
  }

  listControlDecisions(requestId?: string): ControlDecisionRecord[] {
    return this.list(this.controlDecisions).filter(
      (record) => !requestId || record.requestId === requestId,
    );
  }

  recordPerformance(record: AgentPerformanceAggregate): void {
    this.put(this.performance, record.aggregateId, record);
  }

  listPerformance(instanceId?: string): AgentPerformanceAggregate[] {
    return this.list(this.performance).filter(
      (record) => !instanceId || record.instanceId === instanceId,
    );
  }

  upsertResourceAccount(record: ResourceAccount): void {
    this.put(this.resources, record.resourceAccountId, record);
  }

  getResourceAccount(resourceAccountId: string): ResourceAccount | undefined {
    return this.read(this.resources.get(resourceAccountId));
  }

  listResourceAccounts(): ResourceAccount[] {
    return this.list(this.resources);
  }

  upsertWorktree(record: WorktreeRecord): void {
    this.put(this.worktrees, record.worktreeId, record);
  }

  getWorktree(worktreeId: string): WorktreeRecord | undefined {
    return this.read(this.worktrees.get(worktreeId));
  }

  listWorktrees(): WorktreeRecord[] {
    return this.list(this.worktrees);
  }

  snapshot(): FleetLedgerSnapshot {
    return this.snapshotAt(this.revision);
  }

  private snapshotAt(revision: number): FleetLedgerSnapshot {
    return {
      schema: FLEET_LEDGER_SNAPSHOT_SCHEMA,
      version: FLEET_LEDGER_SNAPSHOT_VERSION,
      revision,
      missions: this.list(this.missions),
      workItems: this.list(this.workItems),
      sessions: this.list(this.sessions),
      launches: this.list(this.launches),
      usage: this.list(this.usage),
      quotas: this.list(this.quotas),
      quality: this.list(this.quality),
      assignments: this.list(this.assignments),
      controlDecisions: this.list(this.controlDecisions),
      performance: this.list(this.performance),
      resources: this.list(this.resources),
      worktrees: this.list(this.worktrees),
    };
  }

  clear(): void {
    const previous = this.snapshot();
    this.clearMaps();
    try {
      this.persist();
    } catch (error) {
      this.clearMaps();
      this.restore(previous);
      throw error;
    }
  }

  private put<T>(records: Map<string, T>, id: string, record: T): void {
    if (!id.trim()) throw new Error('Ledger records require a non-empty identifier.');
    const errors = validateLedgerPayload(record);
    if (errors.length > 0) throw new Error(errors[0]);
    const previous = records.get(id);
    records.set(id, cloneRecord(record));
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) records.delete(id);
      else records.set(id, previous);
      throw error;
    }
  }

  private read<T>(record: T | undefined): T | undefined {
    return record === undefined ? undefined : cloneRecord(record);
  }

  private list<T>(records: Map<string, T>): T[] {
    return [...records.values()].map((record) => cloneRecord(record));
  }

  private restore(snapshot: FleetLedgerSnapshot): void {
    assertSnapshotSafe(snapshot);
    this.restoreMap(this.missions, snapshot.missions, 'missionId');
    this.restoreMap(this.workItems, snapshot.workItems, 'workItemId');
    this.restoreMap(this.sessions, snapshot.sessions, 'sessionId');
    this.restoreMap(this.launches, snapshot.launches, 'launchId');
    this.restoreMap(this.usage, snapshot.usage, 'usageId');
    this.restoreMap(this.quotas, snapshot.quotas, 'snapshotId');
    this.restoreMap(this.quality, snapshot.quality, 'signalId');
    this.restoreMap(this.assignments, snapshot.assignments, 'decisionId');
    this.restoreMap(this.controlDecisions, snapshot.controlDecisions, 'decisionId');
    this.restoreMap(this.performance, snapshot.performance, 'aggregateId');
    this.restoreMap(this.resources, snapshot.resources, 'resourceAccountId');
    this.restoreMap(this.worktrees, snapshot.worktrees, 'worktreeId');
  }

  private restoreMap<T, K extends keyof T>(target: Map<string, T>, records: T[], idKey: K): void {
    for (const record of records) {
      const id = record[idKey];
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('Ledger snapshot contains a record without an identifier.');
      }
      target.set(id, cloneRecord(record));
    }
  }

  private persist(): void {
    if (!this.persistence) return;
    const nextRevision = this.revision + 1;
    this.persistence.save(this.snapshotAt(nextRevision), {
      expectedRevision: this.revision,
    });
    this.revision = nextRevision;
  }

  private clearMaps(): void {
    for (const records of [
      this.missions,
      this.workItems,
      this.sessions,
      this.launches,
      this.usage,
      this.quotas,
      this.quality,
      this.assignments,
      this.controlDecisions,
      this.performance,
      this.resources,
      this.worktrees,
    ]) {
      records.clear();
    }
  }
}

function cloneRecord<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}
