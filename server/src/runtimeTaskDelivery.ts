import type {
  FleetRuntimeHost,
  RuntimeTaskBrief,
  RuntimeTaskDeliveryRequest,
  RuntimeTaskDeliveryResult,
} from '../../core/src/runtimeContracts.js';

export const RUNTIME_TASK_LIMITS = {
  workItemId: 128,
  title: 160,
  objective: 2_000,
  acceptanceCriteria: 12,
  acceptanceCriterion: 500,
  renderedBrief: 8_000,
} as const;

const TASK_KEYS = ['acceptanceCriteria', 'objective', 'title', 'workItemId'] as const;
const SENSITIVE_CONTENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/i;

export class RuntimeTaskBriefValidationError extends Error {
  readonly code = 'RUNTIME_TASK_BRIEF_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeTaskBriefValidationError';
  }
}

function safeResultId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, RUNTIME_TASK_LIMITS.workItemId) : '';
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new RuntimeTaskBriefValidationError(field + ' must be a string.');
  }
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim();
  if (!normalized) throw new RuntimeTaskBriefValidationError(field + ' must not be empty.');
  if (normalized.length > maxLength) {
    throw new RuntimeTaskBriefValidationError(field + ' exceeds the bounded length.');
  }
  if (SENSITIVE_CONTENT_PATTERN.test(normalized) || BEARER_PATTERN.test(normalized)) {
    throw new RuntimeTaskBriefValidationError(field + ' contains sensitive material.');
  }
  return normalized;
}

function assertExactTaskKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  const expected = [...TASK_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RuntimeTaskBriefValidationError(
      'Task brief accepts only workItemId, title, objective, and acceptanceCriteria.',
    );
  }
}

/** Validate and normalize the only task shape allowed across a runtime boundary. */
export function validateRuntimeTaskBrief(input: unknown): RuntimeTaskBrief {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuntimeTaskBriefValidationError('Task brief must be an object.');
  }
  const value = input as Record<string, unknown>;
  assertExactTaskKeys(value);

  if (!Array.isArray(value.acceptanceCriteria)) {
    throw new RuntimeTaskBriefValidationError('acceptanceCriteria must be an array.');
  }
  if (
    value.acceptanceCriteria.length === 0 ||
    value.acceptanceCriteria.length > RUNTIME_TASK_LIMITS.acceptanceCriteria
  ) {
    throw new RuntimeTaskBriefValidationError('acceptanceCriteria count is outside the bound.');
  }

  const acceptanceCriteria = value.acceptanceCriteria.map((criterion, index) =>
    normalizeText(
      criterion,
      'acceptanceCriteria[' + index + ']',
      RUNTIME_TASK_LIMITS.acceptanceCriterion,
    ),
  );
  return {
    workItemId: normalizeText(value.workItemId, 'workItemId', RUNTIME_TASK_LIMITS.workItemId),
    title: normalizeText(value.title, 'title', RUNTIME_TASK_LIMITS.title),
    objective: normalizeText(value.objective, 'objective', RUNTIME_TASK_LIMITS.objective),
    acceptanceCriteria,
  };
}

/** Render a validated brief as the only text a terminal boundary receives. */
export function renderRuntimeTaskBrief(input: RuntimeTaskBrief): string {
  const task = validateRuntimeTaskBrief(input);
  const rendered = [
    '[Claude Fleet WorkItem ' + task.workItemId + ']',
    'Title: ' + task.title,
    'Objective: ' + task.objective,
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => '- ' + criterion),
  ].join('\n');
  if (rendered.length > RUNTIME_TASK_LIMITS.renderedBrief) {
    throw new RuntimeTaskBriefValidationError('Rendered task brief exceeds the bounded length.');
  }
  return rendered;
}

/**
 * Deliver only a bounded brief through an already-managed host.
 *
 * No host or no optional sendTask boundary is a normal unavailable result.
 * Host errors are intentionally not exposed so terminal/process details and
 * any accidental secret-bearing error text cannot cross the control plane.
 */
export async function deliverRuntimeTask(
  host: Pick<FleetRuntimeHost, 'sendTask'> | undefined,
  request: RuntimeTaskDeliveryRequest,
  now: () => number = () => Date.now(),
): Promise<RuntimeTaskDeliveryResult> {
  const instanceId = safeResultId(request?.instanceId);
  const workItemId = safeResultId(request?.task?.workItemId);
  let task: RuntimeTaskBrief;
  try {
    task = validateRuntimeTaskBrief(request?.task);
  } catch {
    return { instanceId, workItemId, status: 'rejected', reason: 'invalid_brief' };
  }

  if (!instanceId) {
    return { instanceId, workItemId: task.workItemId, status: 'rejected', reason: 'invalid_brief' };
  }
  if (!host?.sendTask) {
    return {
      instanceId,
      workItemId: task.workItemId,
      status: 'unavailable',
      reason: 'boundary_unavailable',
    };
  }

  try {
    await host.sendTask(instanceId, task);
    return {
      instanceId,
      workItemId: task.workItemId,
      status: 'delivered',
      deliveredAt: now(),
    };
  } catch {
    return {
      instanceId,
      workItemId: task.workItemId,
      status: 'unavailable',
      reason: 'host_failed',
    };
  }
}
