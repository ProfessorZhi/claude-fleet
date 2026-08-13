import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type {
  FleetControlApi,
  FleetControlRequest,
  FleetControlResponse,
} from '../../core/src/controlContracts.js';
import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { HOOK_API_PREFIX, MAX_HOOK_BODY_SIZE } from './constants.js';
import type { CoordinatorSession } from './coordinatorSession.js';
import { TelemetryIngestor } from './telemetryIngestor.js';
import type { AgentState } from './types.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** Optional local management-plane API. HTTP only forwards validated JSON requests to it. */
  controlApi?: FleetControlApi;
  /** Optional explicit Coordinator plan/tick session. */
  coordinatorSession?: CoordinatorSession;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerControlRoutes(app, options);
  registerCoordinatorRoutes(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Fleet Control API ─────────────────────────────────────────

function registerControlRoutes(app: FastifyInstance, options: HttpServerOptions): void {
  if (!options.controlApi) return;
  const telemetryIngestor = new TelemetryIngestor(options.controlApi);

  app.post<{ Body: unknown }>(
    '/api/control',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      if (!isJsonObject(request.body)) {
        reply.code(400).send({ error: 'invalid_control_request' });
        return;
      }

      if (hasUnsafeResultFields(request.body)) {
        reply.code(400).send({ error: 'bounded_result_rejected' });
        return;
      }

      try {
        const safeRequest = sanitizeJsonValue(request.body, [options.token]) as FleetControlRequest;
        const response = await options.controlApi!.submit(safeRequest);
        reply.send(sanitizeControlResponse(response, options.token));
      } catch {
        // The HTTP boundary must not disclose adapter errors, request contents,
        // credentials, or stack traces to a local client.
        reply.code(500).send({ error: 'control_request_failed' });
      }
    },
  );

  app.get<{ Params: { instanceId: string } }>(
    '/api/control/instances/:instanceId/diagnostics',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        const instance = await options.controlApi!.getInstance(request.params.instanceId);
        if (!instance) {
          reply.code(404).send({ error: 'instance_not_found' });
          return;
        }
        // This is an explicit allow-list, not the generic response sanitizer:
        // all returned values are booleans, variable names, hosts, or bounded
        // runtime state. Credential values never enter this projection.
        reply.send(runtimeDiagnostics(instance));
      } catch {
        reply.code(500).send({ error: 'control_diagnostics_unavailable' });
      }
    },
  );

  app.get<{ Params: { workItemId: string }; Querystring: { instanceId?: string } }>(
    '/api/control/delivery-diagnostics/:workItemId',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        const diagnostics = options.controlApi!.getDeliveryDiagnostics?.(
          request.params.workItemId,
          request.query.instanceId,
        );
        if (!diagnostics) {
          reply.code(404).send({ error: 'delivery_diagnostics_not_found' });
          return;
        }
        reply.send(sanitizeJsonValue(diagnostics, [options.token]));
      } catch {
        reply.code(500).send({ error: 'delivery_diagnostics_unavailable' });
      }
    },
  );

  app.get<{ Params: { instanceId: string } }>(
    '/api/control/instances/:instanceId',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        const instance = await options.controlApi!.getInstance(request.params.instanceId);
        if (!instance) {
          reply.code(404).send({ error: 'instance_not_found' });
          return;
        }
        reply.send(sanitizeJsonValue(instance, [options.token]));
      } catch {
        reply.code(500).send({ error: 'control_status_unavailable' });
      }
    },
  );

  app.get(
    '/api/control/instances',
    { preHandler: bearerAuth(options.token) },
    async (_request, reply) => {
      try {
        const instances = await options.controlApi!.listInstances();
        reply.send(sanitizeJsonValue(instances, [options.token]));
      } catch {
        reply.code(500).send({ error: 'control_roster_unavailable' });
      }
    },
  );

  app.get<{ Querystring: { instanceId?: string; workItemId?: string } }>(
    '/api/control/metrics',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        const metrics = await options.controlApi!.getMetrics(
          request.query.instanceId,
          request.query.workItemId,
        );
        reply.send(sanitizeJsonValue(metrics, [options.token]));
      } catch {
        reply.code(500).send({ error: 'control_metrics_unavailable' });
      }
    },
  );

  app.get<{ Querystring: { workItemId?: string } }>(
    '/api/control/quality',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        const controlApi = options.controlApi!;
        if (!controlApi.getQuality) {
          reply.code(503).send({ error: 'control_quality_unavailable' });
          return;
        }
        const quality = await controlApi.getQuality(request.query.workItemId);
        reply.send(sanitizeJsonValue(quality, [options.token]));
      } catch {
        reply.code(500).send({ error: 'control_quality_unavailable' });
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/api/control/telemetry',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      if (!isJsonObject(request.body)) {
        reply.code(400).send({ error: 'invalid_telemetry_envelope' });
        return;
      }
      try {
        const result = await telemetryIngestor.ingest(request.body);
        reply.send(sanitizeJsonValue(result, [options.token]));
      } catch {
        // Do not disclose validation details, raw telemetry, or provider data
        // at the HTTP boundary. The caller can inspect the status code and
        // retry with a new idempotency key after correcting its envelope.
        reply.code(400).send({ error: 'telemetry_rejected' });
      }
    },
  );
}

function registerCoordinatorRoutes(app: FastifyInstance, options: HttpServerOptions): void {
  if (!options.coordinatorSession) return;

  app.get(
    '/api/coordinator/session',
    { preHandler: bearerAuth(options.token) },
    async (_request, reply) => {
      reply.send(
        sanitizeJsonValue(
          {
            sessionId: options.coordinatorSession!.sessionId,
            ownerId: options.coordinatorSession!.ownerId,
            policy: options.coordinatorSession!.policy,
          },
          [options.token],
        ),
      );
    },
  );

  app.get<{ Querystring: { requestId?: string } }>(
    '/api/coordinator/plan',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      try {
        reply.send(
          sanitizeJsonValue(
            await invokeCoordinatorHttpSession(
              options.coordinatorSession!,
              'plan',
              request.query.requestId ??
                (typeof request.headers['x-request-id'] === 'string'
                  ? request.headers['x-request-id']
                  : undefined),
            ),
            [options.token],
          ),
        );
      } catch {
        reply.code(500).send({ error: 'coordinator_plan_unavailable' });
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/api/coordinator/tick',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      if (request.body !== undefined && !isJsonObject(request.body)) {
        reply.code(400).send({ error: 'invalid_coordinator_request' });
        return;
      }
      try {
        const requestId = isJsonObject(request.body)
          ? request.body.requestId
          : request.headers['x-request-id'];
        if (requestId !== undefined && typeof requestId !== 'string') {
          reply.code(400).send({ error: 'invalid_coordinator_request_id' });
          return;
        }
        reply.send(
          sanitizeJsonValue(
            await invokeCoordinatorHttpSession(options.coordinatorSession!, 'tick', requestId),
            [options.token],
          ),
        );
      } catch {
        reply.code(500).send({ error: 'coordinator_tick_unavailable' });
      }
    },
  );
}

let coordinatorHttpSequence = 0;

function invokeCoordinatorHttpSession(
  session: CoordinatorSession,
  operation: 'plan' | 'tick',
  requestedId?: string,
): Promise<FleetControlResponse> {
  const requestId =
    requestedId ?? `http-coordinator-${operation}-${Date.now()}-${coordinatorHttpSequence++}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) {
    return Promise.resolve({
      requestId: 'invalid-request',
      decision: 'rejected',
      reason: 'Coordinator requestId must be a safe identifier.',
    });
  }
  return session.invoke({
    requestId,
    sessionId: session.sessionId,
    requestedBy: session.ownerId,
    operation,
    mode: session.policy,
    createdAt: Date.now(),
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SAFE_CLAUDE_CREDENTIAL_VARIABLES = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

function runtimeDiagnostics(instance: FleetInstance): Record<string, unknown> {
  const credentialVariableNames = (instance.authVariableNames ?? []).filter((name) =>
    SAFE_CLAUDE_CREDENTIAL_VARIABLES.has(name),
  );
  const hasBaseUrl = Boolean(instance.baseUrlHost);

  return {
    instanceId: instance.instanceId,
    runtime: instance.runtime,
    providerProfileId: instance.providerProfileId,
    requestedModel: instance.requestedModelId ?? instance.modelId,
    resolvedModel: instance.resolvedModelId ?? instance.modelId,
    secretRefPresent: instance.refPresent === true ? 'YES' : 'NO',
    secretResolution: instance.refResolution === 'success' ? 'SUCCESS' : 'FAIL',
    credentialConfigured: instance.authConfigured === true ? 'YES' : 'NO',
    credentialInjectedIntoRuntime: instance.authInjected === true ? 'YES' : 'NO',
    credentialVariableNames,
    baseUrlHost: instance.baseUrlHost,
    effectiveRuntimeEnvironment: {
      ANTHROPIC_BASE_URL: hasBaseUrl ? 'PRESENT' : 'ABSENT',
      ANTHROPIC_API_KEY: credentialVariableNames.includes('ANTHROPIC_API_KEY')
        ? 'PRESENT'
        : 'ABSENT',
      ANTHROPIC_AUTH_TOKEN: credentialVariableNames.includes('ANTHROPIC_AUTH_TOKEN')
        ? 'PRESENT'
        : 'ABSENT',
    },
    bootstrap: instance.bootstrap
      ? {
          state: instance.bootstrap.state,
          reason: instance.bootstrap.reason,
          detail: instance.bootstrap.detail,
          observedAt: instance.bootstrap.observedAt,
        }
      : undefined,
    status: instance.status,
  };
}

const SENSITIVE_FIELD =
  /(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|secret|credential|transcript|prompt|raw[-_]?event|environment)/i;

const BOUNDED_RESULT_FIELDS = new Set([
  'workItemId',
  'instanceId',
  'outcome',
  'summary',
  'artifactRefs',
  'capturedAt',
  'source',
  'availability',
  'confidence',
]);

function hasUnsafeResultFields(body: Record<string, unknown>): boolean {
  const result = body.result;
  if (!isJsonObject(result)) return false;
  return Object.keys(result).some((field) => !BOUNDED_RESULT_FIELDS.has(field));
}

/** Keep the control response shape while excluding credentials and raw agent data. */
function sanitizeControlResponse(
  response: FleetControlResponse,
  token: string,
): FleetControlResponse {
  return sanitizeJsonValue(response, [token]) as FleetControlResponse;
}

function sanitizeJsonValue(value: unknown, forbiddenValues: readonly string[]): unknown {
  if (typeof value === 'string') {
    return forbiddenValues.some((secret) => secret.length > 0 && value.includes(secret))
      ? '[redacted]'
      : value;
  }
  if (Array.isArray(value)) return value.map((child) => sanitizeJsonValue(child, forbiddenValues));
  if (!isJsonObject(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    sanitized[key] = sanitizeJsonValue(child, forbiddenValues);
  }
  return sanitized;
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // In standalone mode (not embedded), skip auth for WebSocket connections.
    // The server binds to 127.0.0.1, so only local clients can connect.
    // In embedded mode (VS Code), require Bearer token for security.
    if (options.embedded) {
      const auth = request.headers.authorization ?? '';
      const expected = `Bearer ${options.token}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        displayName: agent.displayName,
        providerProfileId: agent.providerProfileId,
        providerDisplayName: agent.providerDisplayName,
        modelId: agent.modelId,
        runtime: agent.runtime,
        createdAt: agent.createdAt,
        managedByFleet: agent.managedByFleet,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Claude Fleet] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${expectedToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
