import type {
  FleetControlRequest,
  FleetControlResponse,
  FleetMetricsSnapshot,
} from '../../core/src/controlContracts.js';
import type { QualitySignal } from '../../core/src/ledgerContracts.js';
import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import type { ServerConfig } from './serverConfig.js';
import type { TelemetryIngestEnvelope, TelemetryIngestResult } from './telemetryIngestor.js';

export type FleetControlServer = Pick<ServerConfig, 'port' | 'token'>;

export type FleetControlFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FleetControlClientOptions {
  /** Injected in tests or alternate hosts; defaults to the global fetch. */
  fetch?: FleetControlFetch;
  /** Defaults to http://127.0.0.1:<port>. */
  baseUrl?: string;
}

export class FleetControlClientError extends Error {
  readonly status?: number;
  readonly operation:
    'submit' | 'getInstance' | 'listInstances' | 'getMetrics' | 'getQuality' | 'ingestTelemetry';

  constructor(
    operation:
      'submit' | 'getInstance' | 'listInstances' | 'getMetrics' | 'getQuality' | 'ingestTelemetry',
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'FleetControlClientError';
    this.operation = operation;
    this.status = status;
  }
}

/**
 * Small authenticated client for the local Fleet Control HTTP boundary.
 *
 * This class deliberately has no process, terminal, scheduler, or retry
 * responsibilities. It only serializes control requests and validates the
 * response envelope before returning it to the caller.
 */
export class FleetControlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FleetControlFetch;

  constructor(config: FleetControlServer, options?: FleetControlClientOptions);
  constructor(port: number, token: string, options?: FleetControlClientOptions);
  constructor(
    configOrPort: FleetControlServer | number,
    tokenOrOptions?: string | FleetControlClientOptions,
    maybeOptions: FleetControlClientOptions = {},
  ) {
    const config =
      typeof configOrPort === 'number'
        ? { port: configOrPort, token: typeof tokenOrOptions === 'string' ? tokenOrOptions : '' }
        : configOrPort;
    const options =
      typeof tokenOrOptions === 'object' && tokenOrOptions !== null ? tokenOrOptions : maybeOptions;

    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new TypeError('Fleet Control port must be a valid TCP port.');
    }
    if (typeof config.token !== 'string' || config.token.length === 0) {
      throw new TypeError('Fleet Control token is required.');
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? `http://127.0.0.1:${config.port}`);
    this.token = config.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async submit(request: FleetControlRequest): Promise<FleetControlResponse> {
    const response = await this.send('submit', '/api/control', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
    });
    return parseControlResponse(response, 'submit');
  }

  async getInstance(instanceId: string): Promise<FleetInstance | undefined> {
    if (!isSafeInstanceId(instanceId)) {
      throw new FleetControlClientError('getInstance', 'instanceId must be a safe identifier.');
    }

    const response = await this.send(
      'getInstance',
      `/api/control/instances/${encodeURIComponent(instanceId)}`,
      { method: 'GET', headers: this.headers() },
      true,
    );
    if (response.status === 404) return undefined;

    const payload = await parseJson(response, 'getInstance');
    return parseInstancePayload(payload);
  }

  async listInstances(): Promise<FleetInstance[]> {
    const response = await this.send('listInstances', '/api/control/instances', {
      method: 'GET',
      headers: this.headers(),
    });
    const payload = await parseJson(response, 'listInstances');
    if (!Array.isArray(payload)) {
      throw new FleetControlClientError(
        'listInstances',
        'Fleet Control returned an invalid roster.',
      );
    }
    return payload
      .map(parseInstancePayload)
      .filter((instance): instance is FleetInstance => !!instance);
  }

  async getMetrics(instanceId?: string, workItemId?: string): Promise<FleetMetricsSnapshot> {
    const query = new URLSearchParams();
    if (instanceId !== undefined) query.set('instanceId', instanceId);
    if (workItemId !== undefined) query.set('workItemId', workItemId);
    const queryString = query.toString();
    const response = await this.send(
      'getMetrics',
      `/api/control/metrics${queryString ? `?${queryString}` : ''}`,
      {
        method: 'GET',
        headers: this.headers(),
      },
    );
    const payload = await parseJson(response, 'getMetrics');
    if (!isRecord(payload) || !Array.isArray(payload.usage) || !Array.isArray(payload.sessions)) {
      throw new FleetControlClientError(
        'getMetrics',
        'Fleet Control returned invalid metrics.',
        200,
      );
    }
    return payload as unknown as FleetMetricsSnapshot;
  }

  async getQuality(workItemId?: string): Promise<QualitySignal[]> {
    const query = workItemId === undefined ? '' : `?workItemId=${encodeURIComponent(workItemId)}`;
    const response = await this.send('getQuality', `/api/control/quality${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const payload = await parseJson(response, 'getQuality');
    if (!Array.isArray(payload)) {
      throw new FleetControlClientError('getQuality', 'Fleet Control returned invalid quality.');
    }
    return payload as QualitySignal[];
  }

  async ingestTelemetry(envelope: TelemetryIngestEnvelope): Promise<TelemetryIngestResult> {
    const response = await this.send('ingestTelemetry', '/api/control/telemetry', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(envelope),
    });
    const payload = await parseJson(response, 'ingestTelemetry');
    if (
      !isRecord(payload) ||
      !isRecord(payload.response) ||
      typeof payload.requestId !== 'string'
    ) {
      throw new FleetControlClientError(
        'ingestTelemetry',
        'Fleet Control returned invalid telemetry ingestion result.',
        response.status,
      );
    }
    return payload as unknown as TelemetryIngestResult;
  }

  private async send(
    operation:
      'submit' | 'getInstance' | 'listInstances' | 'getMetrics' | 'getQuality' | 'ingestTelemetry',
    path: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, init);
    } catch {
      throw new FleetControlClientError(operation, 'Fleet Control request failed.');
    }

    if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new FleetControlClientError(
        operation,
        `Fleet Control request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return response;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new TypeError('Fleet Control base URL is required.');
  return trimmed;
}

async function parseJson(
  response: Response,
  operation: FleetControlClientError['operation'],
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FleetControlClientError(
      operation,
      'Fleet Control returned malformed JSON.',
      response.status,
    );
  }
}

function parseControlResponse(
  response: Response,
  operation: 'submit',
): FleetControlResponse | Promise<FleetControlResponse> {
  return parseJson(response, operation).then((payload) => {
    if (
      !isRecord(payload) ||
      typeof payload.requestId !== 'string' ||
      !isDecision(payload.decision)
    ) {
      throw new FleetControlClientError(
        operation,
        'Fleet Control returned an invalid response.',
        response.status,
      );
    }
    return payload as unknown as FleetControlResponse;
  });
}

function parseInstancePayload(payload: unknown): FleetInstance | undefined {
  if (!isRecord(payload)) {
    throw new FleetControlClientError(
      'getInstance',
      'Fleet Control returned an invalid instance.',
      200,
    );
  }
  const instance = isRecord(payload.instance) ? payload.instance : payload;
  if (typeof instance.instanceId !== 'string' || typeof instance.runtime !== 'string') {
    throw new FleetControlClientError(
      'getInstance',
      'Fleet Control returned an invalid instance.',
      200,
    );
  }
  return instance as unknown as FleetInstance;
}

function isDecision(value: unknown): value is FleetControlResponse['decision'] {
  return (
    value === 'accepted' ||
    value === 'approval_required' ||
    value === 'rejected' ||
    value === 'unavailable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInstanceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
