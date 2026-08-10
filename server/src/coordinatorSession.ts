import type {
  FleetControlRequest,
  FleetControlResponse,
  FleetCoordinatorSessionResult,
} from '../../core/src/controlContracts.js';
import type { FleetControlMode } from '../../core/src/runtimeContracts.js';
import { CoordinatorScheduler, type CoordinatorSchedulerTick } from './coordinatorScheduler.js';

export interface CoordinatorSessionRequest {
  requestId: string;
  sessionId: string;
  requestedBy: string;
  operation: 'plan' | 'tick';
  mode: FleetControlMode;
  createdAt: number;
}

export interface CoordinatorSessionOptions {
  sessionId: string;
  scheduler: CoordinatorScheduler;
  now?: () => number;
}

/**
 * Explicit Coordinator session boundary.
 *
 * The HTTP layer authenticates the caller with its bearer token. This object
 * adds management-plane authorization by binding a safe sessionId to the
 * scheduler owner and fixed policy. It exposes one invocation at a time and
 * never starts a timer, daemon, runtime, or terminal process.
 */
export class CoordinatorSession {
  readonly sessionId: string;

  private readonly scheduler: CoordinatorScheduler;
  private readonly now: () => number;
  private readonly responses = new Map<
    string,
    { fingerprint: string; response: FleetControlResponse }
  >();

  constructor(options: CoordinatorSessionOptions) {
    if (!isSafeId(options.sessionId)) {
      throw new Error('CoordinatorSession sessionId must be a safe identifier.');
    }
    this.sessionId = options.sessionId;
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => Date.now());
  }

  get ownerId(): string {
    return this.scheduler.ownerId;
  }

  get policy(): FleetControlMode {
    return this.scheduler.controlPolicy.mode;
  }

  getSnapshot(): { sessionId: string; ownerId: string; policy: FleetControlMode } {
    return { sessionId: this.sessionId, ownerId: this.ownerId, policy: this.policy };
  }

  plan() {
    return this.scheduler.plan();
  }

  tick() {
    return this.scheduler.tick();
  }

  async invoke(request: CoordinatorSessionRequest): Promise<FleetControlResponse> {
    const fingerprint = JSON.stringify({
      sessionId: request.sessionId,
      requestedBy: request.requestedBy,
      operation: request.operation,
      mode: request.mode,
    });
    const previous = this.responses.get(request.requestId);
    if (previous) {
      return previous.fingerprint === fingerprint
        ? clone(previous.response)
        : rejected(request.requestId, 'requestId was already used with different session input.');
    }

    const validationError = validateSessionRequest(request);
    if (validationError)
      return this.remember(request, fingerprint, rejected(request.requestId, validationError));
    if (request.sessionId !== this.sessionId) {
      return this.remember(
        request,
        fingerprint,
        rejected(request.requestId, 'Coordinator session is not registered.'),
      );
    }
    if (request.requestedBy !== this.ownerId) {
      return this.remember(
        request,
        fingerprint,
        rejected(request.requestId, 'Coordinator requester is not authorized for this session.'),
      );
    }
    if (request.mode !== this.policy) {
      return this.remember(
        request,
        fingerprint,
        rejected(request.requestId, `Coordinator policy is fixed at ${this.policy}.`),
      );
    }

    try {
      if (request.operation === 'plan') {
        const plan = await this.scheduler.plan();
        const coordinator: FleetCoordinatorSessionResult = {
          sessionId: this.sessionId,
          operation: 'plan',
          capturedAt: plan.capturedAt,
          plan,
        };
        return this.remember(request, fingerprint, {
          requestId: request.requestId,
          decision: 'accepted',
          coordinator,
          acceptedAt: plan.capturedAt,
        });
      }

      const tick: CoordinatorSchedulerTick = await this.scheduler.tick();
      const coordinator: FleetCoordinatorSessionResult = {
        sessionId: this.sessionId,
        operation: 'tick',
        capturedAt: tick.plan.capturedAt,
        tick,
      };
      return this.remember(request, fingerprint, {
        requestId: request.requestId,
        decision: 'accepted',
        coordinator,
        acceptedAt: tick.plan.capturedAt,
      });
    } catch {
      return this.remember(request, fingerprint, {
        requestId: request.requestId,
        decision: 'unavailable',
        reason: 'Coordinator session invocation failed.',
        acceptedAt: this.now(),
      });
    }
  }

  private remember(
    request: CoordinatorSessionRequest,
    fingerprint: string,
    response: FleetControlResponse,
  ): FleetControlResponse {
    this.responses.set(request.requestId, { fingerprint, response: clone(response) });
    return clone(response);
  }
}

export function coordinatorSessionRequestFromControl(
  request: FleetControlRequest,
): CoordinatorSessionRequest {
  return {
    requestId: request.requestId,
    sessionId: request.coordinatorSession!.sessionId,
    requestedBy: request.requestedBy,
    operation: request.coordinatorSession!.operation,
    mode: request.mode,
    createdAt: request.createdAt,
  };
}

function validateSessionRequest(request: CoordinatorSessionRequest): string | null {
  if (!isSafeId(request.requestId)) return 'requestId must be a safe identifier.';
  if (!isSafeId(request.sessionId)) return 'sessionId must be a safe identifier.';
  if (!isSafeId(request.requestedBy)) return 'requestedBy must be a safe identifier.';
  if (request.operation !== 'plan' && request.operation !== 'tick') {
    return 'Coordinator operation must be plan or tick.';
  }
  if (!Number.isFinite(request.createdAt) || request.createdAt <= 0) {
    return 'createdAt must be a positive timestamp.';
  }
  return null;
}

function rejected(requestId: string, reason: string): FleetControlResponse {
  return { requestId, decision: 'rejected', reason };
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
