import type { FleetControlApi, FleetControlResponse } from '../../core/src/controlContracts.js';
import type { FleetEvent } from '../../core/src/fleetTelemetry.js';

/**
 * Converts only normalized terminal events into bounded WorkItem results.
 * Raw event payloads, transcript text, and error messages never cross this
 * boundary. Duplicate eventIds are idempotent.
 */
export class WorkItemResultCorrelator {
  /** Legacy event-id idempotency, retained for non-Claude adapters. */
  private readonly responses = new Map<string, FleetControlResponse>();
  /** Claude completion idempotency is scoped to the active WorkItem/session. */
  private readonly completionResponses = new Map<string, FleetControlResponse>();
  private readonly completionClaims = new Set<string>();
  private readonly completionInFlight = new Map<
    string,
    Promise<FleetControlResponse | undefined>
  >();
  private readonly completedByInstanceSession = new Map<string, FleetControlResponse>();
  /** A prompt ACK is valid only for one active WorkItem and exact native session. */
  private readonly promptAcks = new Set<string>();

  constructor(
    private readonly control: FleetControlApi,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Record the provider's UserPromptSubmit as an ACK for the current managed
   * WorkItem. Sending text to a host terminal is not enough: the instance,
   * session and delivery lifecycle must all match first.
   */
  async acceptPrompt(instanceId: string, sessionId: string): Promise<boolean> {
    const context = await this.activeContext(instanceId, sessionId);
    if (!context) return false;
    const key = contextKey(instanceId, context.workItemId, sessionId);
    this.promptAcks.add(key);
    return true;
  }

  async consume(event: FleetEvent): Promise<FleetControlResponse | undefined> {
    if (event.eventType !== 'task_finished' && event.eventType !== 'error') return undefined;
    const eventId = safeId(event.eventId);
    if (!eventId || !event.instanceId) return undefined;
    const previous = this.responses.get(eventId);
    if (previous) return clone(previous);

    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    if (sessionId) {
      const previousCompletion = this.completedByInstanceSession.get(
        `${safeId(event.instanceId)}:${safeId(sessionId)}:${event.eventType}`,
      );
      if (previousCompletion) return clone(previousCompletion);
    }
    const context = await this.activeContext(event.instanceId, sessionId);
    if (!context) return undefined;
    const requiresPromptAck = event.runtime === 'claude-code' || event.source === 'claude-hook';
    const activeSessionId = sessionId ?? context.sessionId;
    if (requiresPromptAck) {
      if (!activeSessionId) return undefined;
      const promptKey = contextKey(event.instanceId, context.workItemId, activeSessionId);
      if (!this.promptAcks.has(promptKey)) return undefined;
    }

    const completionKey = `${contextKey(event.instanceId, context.workItemId, activeSessionId ?? '-')}:${event.eventType}`;
    const completed = this.completionResponses.get(completionKey);
    if (completed) return clone(completed);
    const inFlight = this.completionInFlight.get(completionKey);
    if (inFlight) {
      const response = await inFlight;
      return response ? clone(response) : undefined;
    }
    if (this.completionClaims.has(completionKey)) return undefined;
    this.completionClaims.add(completionKey);

    const responsePromise = this.control.submit({
      requestId: `runtime-result-${safeId(completionKey)}`,
      action: 'collect_result',
      mode: 'approve',
      requestedBy: 'runtime-correlation',
      workItemId: context.workItemId,
      result: {
        workItemId: context.workItemId,
        instanceId: event.instanceId,
        outcome: event.eventType === 'task_finished' ? 'completed' : 'failed',
        summary:
          event.eventType === 'task_finished'
            ? 'Runtime reported task completion.'
            : 'Runtime reported a task error.',
        capturedAt: safeTimestamp(event.observedAt, this.now),
        source: 'runtime',
        availability: 'available',
        confidence: 'high',
      },
      createdAt: safeTimestamp(event.observedAt, this.now),
    });
    this.completionInFlight.set(completionKey, responsePromise);
    try {
      const response = await responsePromise;
      this.completionResponses.set(completionKey, clone(response));
      if (activeSessionId) {
        this.completedByInstanceSession.set(
          `${safeId(event.instanceId)}:${safeId(activeSessionId)}:${event.eventType}`,
          clone(response),
        );
      }
      this.responses.set(eventId, clone(response));
      return clone(response);
    } finally {
      this.completionInFlight.delete(completionKey);
    }
  }

  private async activeContext(
    instanceId: string,
    sessionId?: string,
  ): Promise<{ workItemId: string; sessionId?: string } | undefined> {
    const instance = await this.control.getInstance(instanceId);
    const workItemId = instance?.workItemId;
    if (!workItemId) return undefined;
    if (sessionId && instance?.sessionId !== sessionId) return undefined;
    const delivery = this.control.getDeliveryStatus?.(workItemId, instanceId);
    if (delivery && delivery.lifecycle !== 'delivered_to_runtime') return undefined;
    return { workItemId, sessionId: instance?.sessionId };
  }
}

function contextKey(instanceId: string, workItemId: string, sessionId: string): string {
  return `${safeId(instanceId)}:${safeId(workItemId)}:${safeId(sessionId)}`;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]/g, '-');
  return normalized.slice(0, 100);
}

function safeTimestamp(value: unknown, fallback: () => number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
