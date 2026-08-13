import type { FleetIdentity } from './fleetContracts.js';
import type { AgentRole, FleetRuntime, RuntimeBootstrapSnapshot } from './runtimeContracts.js';

export type { AgentRole, FleetRuntime } from './runtimeContracts.js';

export type FleetEventType =
  | 'runtime_ready'
  | 'prompt_accepted'
  | 'assistant_message'
  | 'session_started'
  | 'session_resumed'
  | 'agent_started'
  | 'agent_stopped'
  | 'tool_started'
  | 'tool_finished'
  | 'task_started'
  | 'task_finished'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'error'
  | 'subagent_started'
  | 'subagent_finished'
  | 'provider_switched'
  | 'context_updated'
  | 'handoff';

export interface FleetContextUsage {
  usedTokens?: number;
  limitTokens?: number;
}

/** Normalized, secret-free event consumed by projections and future adapters. */
export interface FleetEvent {
  eventId: string;
  eventType: FleetEventType;
  observedAt: number;
  source: 'agent-state' | 'claude-hook' | 'claude-jsonl' | 'agentmetrics' | 'external';
  instanceId?: string;
  agentId?: number;
  runtime?: FleetRuntime;
  managedByFleet?: boolean;
  repo?: string;
  cwd?: string;
  hostId?: string;
  workspaceId?: string;
  terminalId?: string;
  terminalName?: string;
  displayName?: string;
  launchSource?: string;
  requestedBy?: string;
  sessionId?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  fleet?: FleetIdentity;
  role?: AgentRole;
  parentAgentId?: string;
  leadAgentId?: string;
  bootstrap?: RuntimeBootstrapSnapshot;
  status?: string;
  currentTool?: string;
  currentTask?: string;
  workItemId?: string;
  completionUnread?: boolean;
  resultSummary?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
  contextUsage?: FleetContextUsage;
  error?: { message: string; timestamp: number; source: string };
}

export interface FleetTelemetrySnapshot {
  instanceId: string;
  agentId?: number;
  runtime: FleetRuntime;
  managedByFleet?: boolean;
  repo?: string;
  cwd?: string;
  hostId?: string;
  workspaceId?: string;
  terminalId?: string;
  terminalName?: string;
  displayName?: string;
  launchSource?: string;
  requestedBy?: string;
  sessionId?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  status?: string;
  currentTool?: string;
  currentTask?: string;
  workItemId?: string;
  completionUnread?: boolean;
  resultSummary?: string;
  usage?: FleetEvent['usage'];
  costUsd?: number;
  contextUsage?: FleetContextUsage;
  lastActivityAt?: number;
  error?: { message: string; timestamp: number; source: string };
  fleet?: FleetIdentity;
  role?: AgentRole;
  parentAgentId?: string;
  leadAgentId?: string;
  bootstrap?: RuntimeBootstrapSnapshot;
  /** Bounded events for this instance, newest last. */
  recentEvents: FleetEvent[];
}

export interface FleetTelemetryProjection {
  snapshots: FleetTelemetrySnapshot[];
  recentEvents: FleetEvent[];
}

function statusFromEventType(eventType: FleetEventType): string | undefined {
  switch (eventType) {
    case 'runtime_ready':
      return 'idle';
    case 'prompt_accepted':
    case 'assistant_message':
      return 'working';
    case 'session_started':
    case 'agent_started':
      return 'starting';
    case 'agent_stopped':
      return 'stopped';
    case 'tool_started':
    case 'task_started':
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'idle':
    case 'task_finished':
      return 'idle';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

/**
 * Small in-memory telemetry store. It intentionally does not persist raw
 * transcripts or create a tracing backend; the bounded projection is enough
 * for the Alpha UI and can later be backed by a durable adapter.
 */
export class FleetTelemetryStore {
  private readonly snapshotsByInstance = new Map<string, FleetTelemetrySnapshot>();
  private readonly events: FleetEvent[] = [];
  private readonly seenEventIds = new Set<string>();

  private readonly historyLimit: number;

  constructor(maxEvents = 50) {
    this.historyLimit = Number.isFinite(maxEvents) ? Math.max(1, Math.floor(maxEvents)) : 50;
  }

  consume(event: FleetEvent): void {
    if (!event.eventId || this.seenEventIds.has(event.eventId)) return;
    this.seenEventIds.add(event.eventId);
    this.events.push(event);
    while (this.events.length > this.historyLimit) {
      const removed = this.events.shift();
      if (removed) this.seenEventIds.delete(removed.eventId);
    }

    if (!event.instanceId) return;
    const previous = this.snapshotsByInstance.get(event.instanceId);
    const eventStatus = event.status ?? statusFromEventType(event.eventType);
    const next: FleetTelemetrySnapshot = {
      instanceId: event.instanceId,
      agentId: event.agentId ?? previous?.agentId,
      runtime: event.runtime ?? previous?.runtime ?? 'other',
      managedByFleet: event.managedByFleet ?? previous?.managedByFleet,
      repo: event.repo ?? previous?.repo,
      cwd: event.cwd ?? previous?.cwd,
      hostId: event.hostId ?? previous?.hostId,
      workspaceId: event.workspaceId ?? previous?.workspaceId,
      terminalId: event.terminalId ?? previous?.terminalId,
      terminalName: event.terminalName ?? previous?.terminalName,
      displayName: event.displayName ?? previous?.displayName,
      launchSource: event.launchSource ?? previous?.launchSource,
      requestedBy: event.requestedBy ?? previous?.requestedBy,
      sessionId: event.sessionId ?? previous?.sessionId,
      providerProfileId: event.providerProfileId ?? previous?.providerProfileId,
      providerDisplayName: event.providerDisplayName ?? previous?.providerDisplayName,
      modelId: event.modelId ?? previous?.modelId,
      status: eventStatus ?? previous?.status,
      currentTool: event.currentTool ?? previous?.currentTool,
      currentTask: event.currentTask ?? previous?.currentTask,
      workItemId: event.workItemId ?? previous?.workItemId,
      completionUnread: event.completionUnread ?? previous?.completionUnread,
      resultSummary: event.resultSummary ?? previous?.resultSummary,
      usage: event.usage ?? previous?.usage,
      costUsd: event.costUsd ?? previous?.costUsd,
      contextUsage: event.contextUsage ?? previous?.contextUsage,
      lastActivityAt: event.observedAt,
      error: event.error ?? (event.eventType === 'error' ? previous?.error : undefined),
      fleet: event.fleet ?? previous?.fleet,
      role: event.role ?? previous?.role,
      parentAgentId: event.parentAgentId ?? previous?.parentAgentId,
      leadAgentId: event.leadAgentId ?? previous?.leadAgentId,
      bootstrap: event.bootstrap ?? previous?.bootstrap,
      recentEvents: [...(previous?.recentEvents ?? []), event].slice(-this.historyLimit),
    };

    if (event.eventType === 'agent_stopped') next.status = 'stopped';
    if (event.eventType === 'tool_finished') {
      next.currentTool = undefined;
    }
    this.snapshotsByInstance.set(event.instanceId, next);
  }

  getSnapshot(instanceId: string): FleetTelemetrySnapshot | undefined {
    const value = this.snapshotsByInstance.get(instanceId);
    return value
      ? {
          ...value,
          contextUsage: value.contextUsage && { ...value.contextUsage },
          bootstrap: value.bootstrap && { ...value.bootstrap },
          recentEvents: [...value.recentEvents],
        }
      : undefined;
  }

  getProjection(): FleetTelemetryProjection {
    return {
      snapshots: [...this.snapshotsByInstance.values()].map((snapshot) => ({
        ...snapshot,
        contextUsage: snapshot.contextUsage && { ...snapshot.contextUsage },
        bootstrap: snapshot.bootstrap && { ...snapshot.bootstrap },
        recentEvents: [...snapshot.recentEvents],
      })),
      recentEvents: [...this.events],
    };
  }

  clear(): void {
    this.snapshotsByInstance.clear();
    this.events.length = 0;
    this.seenEventIds.clear();
  }
}

let eventSequence = 0;

/**
 * Convert an existing Claude Fleet webview broadcast into a safe FleetEvent.
 * Unknown messages are ignored so protocol additions do not create fake data.
 */
export function normalizeAgentBroadcast(
  message: Record<string, unknown>,
  seed: Partial<FleetTelemetrySnapshot>,
): FleetEvent | undefined {
  const id = typeof message.id === 'number' ? message.id : seed.agentId;
  if (typeof id !== 'number') return undefined;
  const type = message.type;
  const now = Date.now();
  const eventId = `agent-${id}-${now}-${eventSequence++}`;
  const base = {
    eventId,
    observedAt: now,
    source: 'agent-state' as const,
    instanceId: seed.instanceId ?? `agent-${id}`,
    agentId: id,
    runtime: seed.runtime ?? 'claude-code',
    managedByFleet: seed.managedByFleet,
    repo: seed.repo,
    cwd: seed.cwd,
    hostId: seed.hostId,
    workspaceId: seed.workspaceId,
    terminalId: seed.terminalId,
    terminalName: seed.terminalName,
    displayName: seed.displayName,
    launchSource: seed.launchSource,
    requestedBy: seed.requestedBy,
    sessionId: seed.sessionId,
    providerProfileId: seed.providerProfileId,
    providerDisplayName: seed.providerDisplayName,
    modelId: seed.modelId,
    fleet: seed.fleet,
    role: seed.role,
    parentAgentId: seed.parentAgentId,
    leadAgentId: seed.leadAgentId,
    bootstrap: seed.bootstrap,
  } satisfies Partial<FleetEvent>;

  switch (type) {
    case 'agentCreated':
      return { ...base, eventType: 'agent_started', status: 'starting' };
    case 'agentClosed':
      return { ...base, eventType: 'agent_stopped', status: 'stopped' };
    case 'agentStatus': {
      const status = typeof message.status === 'string' ? message.status : undefined;
      if (!status) return undefined;
      const eventType: FleetEventType =
        status === 'working' || status === 'active'
          ? 'working'
          : status === 'waiting'
            ? 'waiting'
            : status === 'idle'
              ? 'idle'
              : status === 'error'
                ? 'error'
                : 'working';
      return { ...base, eventType, status };
    }
    case 'agentToolStart':
      return {
        ...base,
        eventType: 'tool_started',
        status: 'working',
        currentTool: typeof message.toolName === 'string' ? message.toolName : undefined,
      };
    case 'agentToolDone':
      return {
        ...base,
        eventType: 'tool_finished',
        currentTool: typeof message.toolId === 'string' ? message.toolId : undefined,
      };
    case 'agentContextUsage':
      return {
        ...base,
        eventType: 'context_updated',
        contextUsage: {
          usedTokens: typeof message.contextTokens === 'number' ? message.contextTokens : undefined,
          limitTokens:
            typeof message.maxContextTokens === 'number' ? message.maxContextTokens : undefined,
        },
      };
    case 'subagentToolStart':
      return { ...base, eventType: 'subagent_started', role: 'subagent' };
    case 'subagentToolDone':
    case 'subagentClear':
      return { ...base, eventType: 'subagent_finished', role: 'subagent' };
    default:
      return undefined;
  }
}
