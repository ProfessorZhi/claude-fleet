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

/**
 * Small in-memory ledger for the management plane.
 *
 * The ledger stores bounded, secret-free metadata only. It intentionally does
 * not persist transcripts, run scheduling, spawn runtimes, or act as a cloud
 * database. A durable adapter can be added later without changing callers.
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

  listSessions(instanceId?: string): SessionRecord[] {
    return this.list(this.sessions).filter(
      (record) => !instanceId || record.instanceId === instanceId,
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

  listUsage(instanceId?: string): UsageRecord[] {
    return this.list(this.usage).filter(
      (record) => !instanceId || record.instanceId === instanceId,
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

  clear(): void {
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
    ]) {
      records.clear();
    }
  }

  private put<T>(records: Map<string, T>, id: string, record: T): void {
    if (!id.trim()) throw new Error('Ledger records require a non-empty identifier.');
    const errors = validateLedgerPayload(record);
    if (errors.length > 0) throw new Error(errors[0]);
    records.set(id, cloneRecord(record));
  }

  private read<T>(record: T | undefined): T | undefined {
    return record === undefined ? undefined : cloneRecord(record);
  }

  private list<T>(records: Map<string, T>): T[] {
    return [...records.values()].map((record) => cloneRecord(record));
  }
}

function cloneRecord<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}
