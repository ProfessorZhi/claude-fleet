import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FleetControlApi,
  FleetControlRequest,
  FleetControlResponse,
} from '../../core/src/controlContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';

// Use isolated temp HOME to avoid touching real ~/.pixel-agents/
let tmpBase: string;
let serverJsonDir: string;
let serverJsonPath: string;
let registryDir: string;

/** List registry entry files (excludes .tmp write-in-progress artifacts). */
function registryFiles(): string[] {
  try {
    return fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Must import AFTER mock setup
const { ClaudeFleetServer } = await import('../src/server.js');

async function postHook(
  port: number,
  token: string,
  body: string,
  providerId = 'claude',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

describe('ClaudeFleetServer', () => {
  let server: InstanceType<typeof ClaudeFleetServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    serverJsonDir = path.join(tmpBase, '.claude-fleet');
    serverJsonPath = path.join(serverJsonDir, 'server.json');
    registryDir = path.join(serverJsonDir, 'servers');
    fs.mkdirSync(serverJsonDir, { recursive: true });
    server = new ClaudeFleetServer();
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Server starts and returns config
  it('starts and returns config with port, token, pid', async () => {
    const config = await server.start();
    expect(config.port).toBeGreaterThan(0);
    expect(config.token).toBeTruthy();
    expect(config.pid).toBe(process.pid);
    expect(config.startedAt).toBeGreaterThan(0);
  });

  // 2. Health endpoint returns 200 + uptime
  it('health endpoint returns 200 with uptime', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  // 3. Hook endpoint requires auth
  it('hook endpoint returns 401 without auth', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/claude`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // 4. Hook endpoint accepts valid auth
  it('hook endpoint returns 200 with valid auth', async () => {
    const config = await server.start();
    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
    );
    expect(res.status).toBe(200);
  });

  // 5. Hook callback fires on valid event
  it('hook callback fires on valid event', async () => {
    const config = await server.start();
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId: string, event: Record<string, unknown>) => {
      received.push({ providerId, event });
    });

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('claude');
    expect(received[0].event.session_id).toBe('abc');
    expect(received[0].event.hook_event_name).toBe('Stop');
  });

  // 6. Hook endpoint rejects oversized body
  it('hook endpoint returns 413 for oversized body', async () => {
    const config = await server.start();
    const bigBody = 'x'.repeat(70_000); // > 64KB
    const res = await postHook(config.port, config.token, bigBody);
    expect(res.status).toBe(413);
  });

  // 7. Hook endpoint rejects invalid JSON
  it('hook endpoint returns 400 for invalid JSON', async () => {
    const config = await server.start();
    const res = await postHook(config.port, config.token, 'not json {{{');
    expect(res.status).toBe(400);
  });

  // 8. Hook endpoint rejects missing provider ID
  it('hook endpoint returns 400 for missing provider ID', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  // 9. server.json written
  it('writes server.json with port, pid, token', async () => {
    const config = await server.start();
    const json = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    expect(json.port).toBe(config.port);
    expect(json.pid).toBe(process.pid);
    expect(json.token).toBe(config.token);
  });

  // 10. Registry entry written alongside the legacy server.json
  it('writes a registry entry with port, pid, servesSpa, protocol', async () => {
    const config = await server.start();
    const files = registryFiles();
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(registryDir, files[0]), 'utf-8'));
    expect(entry.port).toBe(config.port);
    expect(entry.pid).toBe(process.pid);
    expect(entry.token).toBe(config.token);
    expect(entry.servesSpa).toBe(false); // embedded (default) never serves the SPA
    expect(typeof entry.protocol).toBe('number');
  });

  // 11. Second instance, same capability (embedded+embedded), reuses existing server
  it('second embedded instance reuses an existing embedded server', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new ClaudeFleetServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).toBe(config1.port);
    expect(config2.pid).toBe(config1.pid);
    expect(registryFiles()).toHaveLength(1); // reuse -- server2 wrote no entry of its own
    server2.stop(); // should not delete server.json / the registry entry (not owner)
  });

  // 12. Second instance, same capability (standalone+standalone), reuses existing server
  it('second standalone instance reuses an existing standalone server', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new ClaudeFleetServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).toBe(config1.port);
    expect(registryFiles()).toHaveLength(1);
    server2.stop();
  });

  // 13. Capability mismatch: a standalone caller never reuses an embedded server
  it('standalone does not reuse an existing embedded server; starts its own', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new ClaudeFleetServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 14. Capability mismatch, mirrored: an embedded caller never reuses a standalone server
  it('embedded does not reuse an existing standalone server; starts its own', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new ClaudeFleetServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 15. Embedded + standalone coexist: two independent live registry entries, neither reuses
  it('embedded and standalone servers coexist as two live registry entries', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new ClaudeFleetServer();
    const standaloneConfig = await standalone.start({ embedded: false });

    expect(standaloneConfig.port).not.toBe(embeddedConfig.port);
    expect(standaloneConfig.token).not.toBe(embeddedConfig.token);
    const files = registryFiles();
    expect(files).toHaveLength(2);
    const entries = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')),
    );
    expect(entries.some((e) => e.servesSpa === false && e.port === embeddedConfig.port)).toBe(true);
    expect(entries.some((e) => e.servesSpa === true && e.port === standaloneConfig.port)).toBe(
      true,
    );

    standalone.stop();
  });

  // 16. Dead-pid registry entries are pruned on start, never reused
  it('prunes dead-pid registry entries on start instead of reusing them', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const staleFile = path.join(registryDir, '999999-9999.json');
    fs.writeFileSync(
      staleFile,
      JSON.stringify({
        port: 9999,
        pid: 999999,
        token: 'stale',
        startedAt: 0,
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(fs.existsSync(staleFile)).toBe(false); // pruned, not left behind
    expect(config.port).not.toBe(9999); // never reused the dead entry -- started its own
    expect(registryFiles()).toHaveLength(1); // only the freshly-started server's entry remains
  });

  // 17. Structurally invalid live-pid entries are malformed, not reusable
  it('prunes a structurally invalid live-pid entry instead of reusing it', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const malformedFile = path.join(registryDir, `${process.pid}-70000.json`);
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({
        port: 70_000,
        pid: process.pid,
        token: 'invalid-port',
        startedAt: Date.now(),
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(config.port).not.toBe(70_000);
    expect(fs.existsSync(malformedFile)).toBe(false);
    expect(registryFiles()).toHaveLength(1);
  });

  // 18. server.json cleaned up on stop
  it('deletes server.json on stop', async () => {
    await server.start();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
    server.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });

  // 19. server.json NOT deleted if PID mismatch
  it('does not delete server.json if PID mismatch', async () => {
    // Write fake server.json with different PID
    fs.writeFileSync(
      serverJsonPath,
      JSON.stringify({ port: 9999, pid: 999999, token: 'fake', startedAt: 0 }),
    );
    // Server never started (it would reuse), just stop
    const server2 = new ClaudeFleetServer();
    server2.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
  });

  // 20. stop() removes only this server's own registry entry, preserves the other's (D6)
  it('deletes only its own registry entry on stop, preserving a coexisting server', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new ClaudeFleetServer();
    const standaloneConfig = await standalone.start({ embedded: false });
    expect(registryFiles()).toHaveLength(2);

    standalone.stop();

    // Only the standalone's own entry is gone; the still-running embedded
    // server's registry entry is untouched (self-only cleanup, D6).
    const remaining = registryFiles().map(
      (f) => JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')) as { port: number },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].port).toBe(embeddedConfig.port);
    expect(remaining.some((e) => e.port === standaloneConfig.port)).toBe(false);
  });

  // 21. Unknown route returns 404
  it('unknown route returns 404', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/random/path`);
    expect(res.status).toBe(404);
  });

  // 22. Hook callback does NOT fire for events missing required fields
  it('hook callback does not fire for events without session_id', async () => {
    const config = await server.start();
    const received: unknown[] = [];
    server.onHookEvent((_pid: string, event: Record<string, unknown>) => received.push(event));

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ hook_event_name: 'Stop' }), // missing session_id
    );

    expect(received).toHaveLength(0);
  });
});

describe('local Fleet Control HTTP endpoint', () => {
  const token = 'http-test-token';
  let handle: Awaited<ReturnType<typeof createHttpServer>> | undefined;

  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  function createFakeControlApi(): FleetControlApi & { requests: FleetControlRequest[] } {
    const requests: FleetControlRequest[] = [];
    return {
      requests,
      async submit(request) {
        requests.push(request);
        return {
          requestId: request.requestId,
          decision: 'accepted',
          reason: 'fake accepted',
          acceptedAt: 123,
        } satisfies FleetControlResponse;
      },
      async getInstance(instanceId) {
        return {
          instanceId,
          runtime: 'claude-code',
          role: 'worker',
          managedByFleet: true,
          status: 'working',
          repo: 'agent-fleet',
          cwd: 'F:/repo',
          sessionId: 'session-1',
          providerProfileId: 'safe-profile',
          modelId: 'safe-model',
          secretToken: 'must-not-leak',
        } as never;
      },
      async listInstances() {
        return [];
      },
      async getMetrics() {
        return {
          capturedAt: 123,
          usage: [],
          sessions: [],
          quotas: [],
          totals: { durationMs: 0, tokens: {} },
        };
      },
      async getMission() {
        return undefined;
      },
      async getWorkItem() {
        return undefined;
      },
    };
  }

  async function startControlServer(controlApi: FleetControlApi): Promise<number> {
    handle = await createHttpServer({
      embedded: true,
      token,
      store: new AgentStateStore(),
      controlApi,
    });
    return handle.port;
  }

  it('requires Bearer auth and forwards a JSON control request', async () => {
    const api = createFakeControlApi();
    const port = await startControlServer(api);
    const payload = {
      requestId: 'req-1',
      action: 'get_status',
      mode: 'observe',
      requestedBy: 'test',
      createdAt: Date.now(),
      apiKey: 'must-not-be-forwarded',
    };

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);
    expect(api.requests).toHaveLength(0);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      requestId: 'req-1',
      decision: 'accepted',
      reason: 'fake accepted',
      acceptedAt: 123,
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ requestId: 'req-1', action: 'get_status' });
    expect(JSON.stringify(api.requests[0])).not.toContain('must-not-be-forwarded');
    expect(JSON.stringify(api.requests[0])).not.toContain(token);
  });

  it('returns a safe error for malformed bodies and adapter failures', async () => {
    const failingApi: FleetControlApi = {
      submit: async () => {
        throw new Error('secret API key and internal stack must stay private');
      },
      getInstance: async () => undefined,
      listInstances: async () => [],
      getMetrics: async () => ({
        capturedAt: 123,
        usage: [],
        sessions: [],
        quotas: [],
        totals: { durationMs: 0, tokens: {} },
      }),
      getMission: async () => undefined,
      getWorkItem: async () => undefined,
    };
    const port = await startControlServer(failingApi);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const malformed = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers,
      body: JSON.stringify(null),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_control_request' });

    const failed = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'req-2' }),
    });
    expect(failed.status).toBe(500);
    const failedBody = JSON.stringify(await failed.json());
    expect(failedBody).toBe('{"error":"control_request_failed"}');
    expect(failedBody).not.toContain('secret');
    expect(failedBody).not.toContain(token);
  });

  it('protects instance status and strips sensitive response fields', async () => {
    const api = createFakeControlApi();
    const port = await startControlServer(api);
    const url = `http://127.0.0.1:${port}/api/control/instances/instance-1`;

    expect((await fetch(url)).status).toBe(401);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('instance-1');
    expect(body).not.toContain('must-not-leak');
    expect(body).not.toContain(token);
  });

  it('returns a protected 404 without exposing lookup details', async () => {
    const api: FleetControlApi = {
      submit: async () => ({ requestId: 'unused', decision: 'unavailable' }),
      getInstance: async () => undefined,
      listInstances: async () => [],
      getMetrics: async () => ({
        capturedAt: 123,
        usage: [],
        sessions: [],
        quotas: [],
        totals: { durationMs: 0, tokens: {} },
      }),
      getMission: async () => undefined,
      getWorkItem: async () => undefined,
    };
    const port = await startControlServer(api);
    const response = await fetch(`http://127.0.0.1:${port}/api/control/instances/missing`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'instance_not_found' });
  });
});
