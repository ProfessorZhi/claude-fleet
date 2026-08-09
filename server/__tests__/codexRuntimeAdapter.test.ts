import * as nodePath from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RuntimeLaunchRequest } from '../../core/src/runtimeContracts.js';
import {
  codexCandidateNames,
  type CodexFileSystem,
  CodexRuntimeAdapter,
  CodexRuntimeUnsupportedError,
  normalizeCodexEvents,
  resolveCodexCli,
} from '../src/providers/codex/codexRuntimeAdapter.js';

function fakeFileSystem(existing: string[]): CodexFileSystem {
  const files = new Set(existing);
  return { existsSync: (candidate) => files.has(candidate) };
}

function request(overrides: Partial<RuntimeLaunchRequest> = {}): RuntimeLaunchRequest {
  return {
    instance: {
      instanceId: 'codex-1',
      runtime: 'codex-cli',
      role: 'worker',
      managedByFleet: true,
      status: 'starting',
      createdAt: 1,
    },
    cwd: 'C:\\repo',
    sessionMode: 'new',
    ...overrides,
  };
}

describe('Codex CLI candidate resolution', () => {
  it('resolves Windows candidates with injected fs/path/verify', async () => {
    const bin = 'C:\\Codex Bin';
    const command = nodePath.win32.join(bin, 'codex.exe');
    const verified: string[] = [];
    const result = await resolveCodexCli({
      platform: 'win32',
      pathEnv: bin,
      path: nodePath.win32,
      fs: fakeFileSystem([command]),
      verify: async (candidate) => {
        verified.push(candidate);
        return 'codex 1.0.0-test';
      },
    });

    expect(codexCandidateNames('win32')).toEqual(['codex.cmd', 'codex.exe', 'codex']);
    expect(result).toMatchObject({
      ok: true,
      command,
      version: 'codex 1.0.0-test',
      source: 'path',
    });
    expect(verified).toEqual([command]);
  });

  it('resolves POSIX codex without touching the real PATH', async () => {
    const command = '/opt/codex/bin/codex';
    const result = await resolveCodexCli({
      platform: 'linux',
      pathEnv: '/opt/codex/bin',
      path: nodePath.posix,
      fs: fakeFileSystem([command]),
      verify: async () => 'codex-test',
    });

    expect(codexCandidateNames('linux')).toEqual(['codex']);
    expect(result).toMatchObject({ ok: true, command });
  });

  it('continues after a broken candidate', async () => {
    const first = 'C:\\broken';
    const second = 'C:\\good';
    const broken = nodePath.win32.join(first, 'codex.cmd');
    const good = nodePath.win32.join(second, 'codex.cmd');
    const result = await resolveCodexCli({
      platform: 'win32',
      pathEnv: first + ';' + second,
      path: nodePath.win32,
      fs: fakeFileSystem([broken, good]),
      verify: async (candidate) => {
        if (candidate === broken) throw new Error('broken');
        return 'good';
      },
    });

    expect(result.command).toBe(good);
  });
});

describe('Codex launch facade', () => {
  it('builds native new and resume argv', async () => {
    const adapter = new CodexRuntimeAdapter({
      platform: 'win32',
      pathEnv: 'C:\\codex',
      path: nodePath.win32,
      fs: fakeFileSystem([nodePath.win32.join('C:\\codex', 'codex.cmd')]),
      verify: async () => 'codex-test',
    });

    const fresh = await adapter.buildLaunchSpec(request({ modelId: 'o4-mini' }));
    expect(fresh).toMatchObject({
      runtime: 'codex-cli',
      command: 'C:\\codex\\codex.cmd',
      args: ['--model', 'o4-mini'],
      cwd: 'C:\\repo',
      sessionMode: 'new',
    });

    const resumed = await adapter.buildLaunchSpec(
      request({ sessionMode: 'resume', sessionId: 'session-42' }),
    );
    expect(resumed.args).toEqual(['resume', 'session-42']);
  });

  it('requires an injected executor for real launch', async () => {
    const adapter = new CodexRuntimeAdapter({
      pathEnv: '/bin',
      path: nodePath.posix,
      fs: fakeFileSystem(['/bin/codex']),
      verify: async () => 'codex-test',
    });

    await expect(adapter.launch(request({ cwd: '/repo' }))).rejects.toBeInstanceOf(
      CodexRuntimeUnsupportedError,
    );
  });

  it('passes the spec to an injected launcher', async () => {
    let captured: string[] = [];
    const adapter = new CodexRuntimeAdapter({
      pathEnv: '/bin',
      path: nodePath.posix,
      fs: fakeFileSystem(['/bin/codex']),
      verify: async () => 'codex-test',
      launch: async (_request, spec) => {
        captured = [spec.command, ...spec.args];
        return { instanceId: 'codex-1', startedAt: 10, sessionId: 'session-1' };
      },
    });

    await expect(adapter.launch(request({ cwd: '/repo' }))).resolves.toMatchObject({
      instanceId: 'codex-1',
    });
    expect(captured).toEqual(['/bin/codex']);
  });
});

describe('Codex JSON and JSONL normalization', () => {
  it('keeps only allowlisted fields and excludes secrets', () => {
    const event = normalizeCodexEvents(
      {
        type: 'item.started',
        event_id: 'evt-1',
        instance_id: 'codex-1',
        session_id: 'session-1',
        cwd: '/repo',
        model: 'o4-mini',
        item: { type: 'command_execution', command: 'echo secret-token' },
        api_key: 'secret-api-key',
        authorization: 'Bearer secret-token',
        unknown_field: 'must-not-appear',
      },
      () => 123,
    )[0];

    expect(event).toMatchObject({
      eventId: 'codex-evt-1',
      eventType: 'tool_started',
      runtime: 'codex-cli',
      source: 'external',
      instanceId: 'codex-1',
      sessionId: 'session-1',
      currentTool: 'command_execution',
      modelId: 'o4-mini',
      observedAt: 123,
    });
    expect(JSON.stringify(event)).not.toContain('secret-api-key');
    expect(JSON.stringify(event)).not.toContain('secret-token');
    expect(JSON.stringify(event)).not.toContain('unknown_field');
    expect(event).not.toHaveProperty('command');
  });

  it('parses JSONL and drops unknown records', () => {
    const events = normalizeCodexEvents(
      [
        JSON.stringify({ type: 'session.started', session_id: 's1' }),
        JSON.stringify({ type: 'unknown.future', secret: 'value' }),
        JSON.stringify({ type: 'turn.completed', session_id: 's1' }),
      ].join('\n'),
      () => 456,
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual(['session_started', 'task_finished']);
  });

  it('does not emit events for malformed or unsupported input', () => {
    const adapter = new CodexRuntimeAdapter({ now: () => 789 });
    expect(adapter.normalizeEvent('not-json')).toBeUndefined();
    expect(adapter.normalizeEvent({ type: 'not-supported' })).toBeUndefined();
  });
});

describe('unsupported lifecycle operations', () => {
  it('fails closed instead of pretending to control a runtime', async () => {
    const adapter = new CodexRuntimeAdapter();
    await expect(adapter.stop('codex-1')).rejects.toBeInstanceOf(CodexRuntimeUnsupportedError);
    await expect(adapter.focus('codex-1')).rejects.toBeInstanceOf(CodexRuntimeUnsupportedError);
    await expect(adapter.restart(request())).rejects.toBeInstanceOf(CodexRuntimeUnsupportedError);
    await expect(adapter.resume(request())).rejects.toBeInstanceOf(CodexRuntimeUnsupportedError);
    await expect(adapter.discover()).rejects.toBeInstanceOf(CodexRuntimeUnsupportedError);
  });
});
