import type { FleetControlApi, FleetControlResponse } from '../../core/src/controlContracts.js';
import type { FleetEvent } from '../../core/src/fleetTelemetry.js';

/**
 * Converts only normalized terminal events into bounded WorkItem results.
 * Raw event payloads, transcript text, and error messages never cross this
 * boundary. Duplicate eventIds are idempotent.
 */
export class WorkItemResultCorrelator {
  private readonly responses = new Map<string, FleetControlResponse>();

  constructor(
    private readonly control: FleetControlApi,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async consume(event: FleetEvent): Promise<FleetControlResponse | undefined> {
    if (event.eventType !== 'task_finished' && event.eventType !== 'error') return undefined;
    const eventId = safeId(event.eventId);
    if (!eventId || !event.instanceId) return undefined;
    const previous = this.responses.get(eventId);
    if (previous) return clone(previous);

    const instance = await this.control.getInstance(event.instanceId);
    const workItemId = instance?.workItemId;
    if (!workItemId) return undefined;

    const response = await this.control.submit({
      requestId: `runtime-result-${eventId}`,
      action: 'collect_result',
      mode: 'approve',
      requestedBy: 'runtime-correlation',
      workItemId,
      result: {
        workItemId,
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
    this.responses.set(eventId, clone(response));
    return clone(response);
  }
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
