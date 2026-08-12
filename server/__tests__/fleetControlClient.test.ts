import { describe, expect, it } from 'vitest';

import type { FleetControlRequest } from '../../core/src/controlContracts.js';
import type { FleetInstance } from '../../core/src/runtimeContracts.js';
import {
  FleetControlClient,
  FleetControlClientError,
  type FleetControlFetch,
} from '../src/fleetControlClient.js';

const request: FleetControlRequest = {
  requestId: 'request-1',
  action: 'get_status',
  mode: 'observe',
  requestedBy: 'codex',
  instanceId: 'instance-1',
  createdAt: 1,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: FleetControlFetch): FleetControlClient {
  return new FleetControlClient({ port: 4321, token: 'super-secret-token' }, { fetch: fetchImpl });
}

describe('FleetControlClient', () => {
  it('posts a typed control request with bearer authentication', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fetchImpl: FleetControlFetch = async (input, requestInit) => {
      url = input;
      init = requestInit;
      return response({ requestId: 'request-1', decision: 'accepted' });
    };

    const result = await client(fetchImpl).submit(request);

    expect(result).toEqual({ requestId: 'request-1', decision: 'accepted' });
    expect(url).toBe('http://127.0.0.1:4321/api/control');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer super-secret-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('serializes provider and model identity without adding credential material', async () => {
    const launchRequest: FleetControlRequest = {
      requestId: 'launch-provider-1',
      action: 'launch_instance',
      mode: 'approve',
      requestedBy: 'codex',
      instanceId: 'agent-1',
      createdAt: 1,
      launch: {
        runtime: 'claude-code',
        role: 'worker',
        repo: 'F:/repo',
        cwd: 'F:/repo',
        providerProfileId: 'deepseek.msk2hxew',
        modelId: 'deepseek-v4-flash',
        launchSource: 'coordinator',
        requestedBy: 'codex',
        policy: { mode: 'approve' },
      },
    };
    let body = '';
    await client(async (_input, init) => {
      body = String(init?.body);
      return response({ requestId: launchRequest.requestId, decision: 'accepted' });
    }).submit(launchRequest);

    expect(JSON.parse(body)).toMatchObject({
      launch: {
        providerProfileId: 'deepseek.msk2hxew',
        modelId: 'deepseek-v4-flash',
      },
    });
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain('authToken');
  });

  it('gets an instance from the status endpoint and accepts an envelope', async () => {
    const instance: FleetInstance = {
      instanceId: 'instance-1',
      runtime: 'claude-code',
      role: 'worker',
      managedByFleet: true,
      status: 'working',
      createdAt: 10,
    };
    let url = '';
    const result = await client(async (input) => {
      url = input;
      return response({ instance });
    }).getInstance('instance-1');

    expect(result).toEqual(instance);
    expect(url).toBe('http://127.0.0.1:4321/api/control/instances/instance-1');
  });

  it('returns undefined for a missing instance', async () => {
    const result = await client(async () => response({ error: 'not found' }, 404)).getInstance(
      'missing',
    );
    expect(result).toBeUndefined();
  });

  it('lists instances and queries token/time/quota metrics', async () => {
    const urls: string[] = [];
    const instances = [
      {
        instanceId: 'instance-1',
        runtime: 'claude-code',
        role: 'worker',
        managedByFleet: true,
        status: 'working',
        createdAt: 10,
      },
    ];
    const controlClient = client(async (input) => {
      urls.push(input);
      if (input.endsWith('/instances')) return response(instances);
      return response({
        capturedAt: 20,
        instanceId: 'instance-1',
        usage: [{ usageId: 'usage-1', tokens: { totalTokens: 42 }, capturedAt: 19 }],
        sessions: [],
        quotas: [{ snapshotId: 'quota-1', used: { amount: 42, unit: 'tokens' } }],
        totals: { durationMs: 1200, tokens: { totalTokens: 42 } },
      });
    });

    await expect(controlClient.listInstances()).resolves.toEqual(instances);
    await expect(controlClient.getMetrics('instance-1')).resolves.toMatchObject({
      totals: { durationMs: 1200, tokens: { totalTokens: 42 } },
    });
    expect(urls).toEqual([
      'http://127.0.0.1:4321/api/control/instances',
      'http://127.0.0.1:4321/api/control/metrics?instanceId=instance-1',
    ]);
  });

  it('fails safely for HTTP errors without exposing the token', async () => {
    let caught: unknown;
    try {
      await client(async () => response({ error: 'Bearer super-secret-token' }, 401)).submit(
        request,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FleetControlClientError);
    expect(String(caught)).not.toContain('super-secret-token');
    expect((caught as FleetControlClientError).status).toBe(401);
  });

  it('fails safely for malformed JSON and transport errors', async () => {
    const malformed = new Response('{', { status: 200 });
    await expect(client(async () => malformed).submit(request)).rejects.toMatchObject({
      operation: 'submit',
      status: 200,
    });
    await expect(
      client(async () => {
        throw new Error('transport failure: super-secret-token');
      }).submit(request),
    ).rejects.toThrow('Fleet Control request failed.');
  });

  it('rejects unsafe instance ids before making a request', async () => {
    let called = false;
    await expect(
      client(async () => {
        called = true;
        return response({});
      }).getInstance('../secret'),
    ).rejects.toThrow('safe identifier');
    expect(called).toBe(false);
  });

  it('supports the port/token constructor overload and strips base URL slashes', async () => {
    let url = '';
    const controlClient = new FleetControlClient(4321, 'token', {
      baseUrl: 'http://fleet.local///',
      fetch: async (input) => {
        url = input;
        return response({ requestId: 'request-1', decision: 'accepted' });
      },
    });

    await controlClient.submit(request);
    expect(url).toBe('http://fleet.local/api/control');
  });
});
