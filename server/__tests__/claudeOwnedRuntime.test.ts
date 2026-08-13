import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  EventEmitter: class<T> {
    private readonly emitter = new (require('node:events').EventEmitter)();
    readonly event = (listener: (value: T) => void) => {
      this.emitter.on('event', listener);
      return { dispose: () => this.emitter.off('event', listener) };
    };
    fire(value: T): void {
      this.emitter.emit('event', value);
    }
    dispose(): void {
      this.emitter.removeAllListeners();
    }
  },
}));

vi.mock('vscode', () => vscodeMock);

import { ClaudeOwnedRuntime } from '../../adapters/vscode/claudeOwnedRuntime.js';

interface FakeChild {
  pid: number;
  stdin: {
    writes: string[];
    write(value: string): boolean;
    end(): void;
  };
  stdout: EventEmitter & { setEncoding(encoding: string): void };
  stderr: EventEmitter & { setEncoding(encoding: string): void };
  kill: ReturnType<typeof vi.fn>;
  once(event: string, listener: (...args: any[]) => void): FakeChild;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.pid = 42;
  child.stdin = {
    writes: [],
    write(value: string) {
      this.writes.push(value);
      return true;
    },
    end: vi.fn(),
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn(() => true);
  child.once = EventEmitter.prototype.once.bind(child) as unknown as FakeChild['once'];
  return child;
}

function terminal() {
  return { name: 'astrid · Claude Code', show: vi.fn(), dispose: vi.fn() };
}

describe('ClaudeOwnedRuntime', () => {
  it('owns stdin and makes submit newline explicit', () => {
    const child = fakeChild();
    const created = terminal();
    const runtime = new ClaudeOwnedRuntime({
      spawn: vi.fn(() => child as never),
      createTerminal: vi.fn(() => created as never),
    });

    const process = runtime.launch({
      externalInstanceId: 'astrid',
      sessionId: 'session-1',
      cwd: 'F:/repo',
      command: 'claude.cmd',
      args: ['--model', 'deepseek-v4-flash'],
      terminalName: 'astrid · Claude Code',
      showTerminal: false,
    });

    process.write('hello');
    process.submit('world');

    expect(child.stdin.writes).toEqual(['hello', 'world\n']);
    expect(process.pid).toBe(42);
    expect(process.alive).toBe(true);
  });

  it('encodes one structured stream-json user message per submit', () => {
    const child = fakeChild();
    const created = terminal();
    const runtime = new ClaudeOwnedRuntime({
      spawn: vi.fn(() => child as never),
      createTerminal: vi.fn(() => created as never),
    });
    const process = runtime.launch({
      externalInstanceId: 'astrid',
      sessionId: 'session-1',
      cwd: 'F:/repo',
      command: 'claude.cmd',
      args: ['-p', '--input-format', 'stream-json'],
      terminalName: 'astrid · Claude Code',
      inputFormat: 'stream-json',
      showTerminal: false,
    });

    process.submit('Respond with exactly OWNED_RUNTIME_OK');

    expect(child.stdin.writes).toHaveLength(1);
    expect(JSON.parse(child.stdin.writes[0])).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Respond with exactly OWNED_RUNTIME_OK' },
      parent_tool_use_id: null,
    });
  });

  it('turns one manual stream-json terminal line into one structured submit', () => {
    const child = fakeChild();
    const created = terminal();
    let terminalOptions: {
      pty?: {
        open?(): void;
        handleInput?(data: string): void;
        onDidWrite: (listener: (value: string) => void) => { dispose(): void };
      };
    } = {};
    const runtime = new ClaudeOwnedRuntime({
      spawn: vi.fn(() => child as never),
      createTerminal: vi.fn((options) => {
        terminalOptions = options as typeof terminalOptions;
        return created as never;
      }),
    });
    runtime.launch({
      externalInstanceId: 'astrid-manual',
      sessionId: 'session-manual',
      cwd: 'F:/repo',
      command: 'claude.cmd',
      args: ['-p', '--input-format', 'stream-json'],
      terminalName: 'astrid-manual · Claude Code',
      inputFormat: 'stream-json',
      showTerminal: false,
    });

    terminalOptions.pty?.open?.();
    terminalOptions.pty?.handleInput?.('Respond with exactly MANUAL_BUFFER_OK');
    terminalOptions.pty?.handleInput?.('\r');

    expect(child.stdin.writes).toHaveLength(1);
    expect(JSON.parse(child.stdin.writes[0])).toMatchObject({
      type: 'user',
      message: { content: 'Respond with exactly MANUAL_BUFFER_OK' },
    });
  });

  it('mirrors stdout and stderr and focuses the mapped terminal', () => {
    const child = fakeChild();
    const created = terminal();
    const output: string[] = [];
    let terminalOptions: {
      pty?: {
        open?(): void;
        handleInput?(data: string): void;
        onDidWrite: (listener: (value: string) => void) => { dispose(): void };
      };
    } = {};
    const runtime = new ClaudeOwnedRuntime({
      spawn: vi.fn(() => child as never),
      createTerminal: vi.fn((options) => {
        terminalOptions = options as typeof terminalOptions;
        return created as never;
      }),
    });
    const process = runtime.launch({
      externalInstanceId: 'astrid',
      sessionId: 'session-1',
      cwd: 'F:/repo',
      command: 'claude.cmd',
      args: [],
      terminalName: 'astrid · Claude Code',
      showTerminal: false,
      onOutput: (stream, chunk) => output.push(`${stream}:${chunk}`),
    });

    const rendered: string[] = [];
    terminalOptions.pty?.onDidWrite((chunk) => rendered.push(chunk));
    terminalOptions.pty?.open?.();
    child.stdout.emit('data', 'out');
    child.stderr.emit('data', 'err');
    terminalOptions.pty?.handleInput?.('manual-input');
    process.focus();

    expect(output).toEqual(['stdout:out', 'stderr:err']);
    expect(rendered).toEqual(['out', 'err']);
    expect(child.stdin.writes).toEqual(['manual-input']);
    expect(created.show).toHaveBeenCalledWith(true);
    expect(runtime.get('astrid')).toBe(process);
  });

  it('stops only the selected process and disposes its terminal', async () => {
    const child = fakeChild();
    const created = terminal();
    const runtime = new ClaudeOwnedRuntime({
      spawn: vi.fn(() => child as never),
      createTerminal: vi.fn(() => created as never),
    });
    runtime.launch({
      externalInstanceId: 'astrid',
      sessionId: 'session-1',
      cwd: 'F:/repo',
      command: 'claude.cmd',
      args: [],
      terminalName: 'astrid · Claude Code',
      showTerminal: false,
    });

    await runtime.stop('astrid');

    expect(child.kill).toHaveBeenCalledOnce();
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(runtime.get('astrid')).toBeUndefined();
  });

  it.skipIf(process.env.CLAUDE_FLEET_REAL_OWNED_RUNTIME !== '1')(
    'accepts a real Claude stream-json turn through the owned process boundary',
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the gated real probe.');

      const childWrites: string[] = [];
      const events: Record<string, unknown>[] = [];
      const rendered: string[] = [];
      const created = terminal();
      let terminalOptions: {
        pty?: {
          open?(): void;
          onDidWrite: (listener: (value: string) => void) => { dispose(): void };
        };
      } = {};
      let exitResolve: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => {
        exitResolve = resolve;
      });

      const runtime = new ClaudeOwnedRuntime({
        createTerminal: vi.fn((options) => {
          terminalOptions = options as typeof terminalOptions;
          return created as never;
        }),
        spawn: ((
          command: string,
          args: readonly string[],
          options: Parameters<typeof nodeSpawn>[2],
        ) => {
          const child = nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;
          const originalWrite = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
            childWrites.push(Buffer.from(chunk).toString('utf8'));
            return originalWrite(chunk, ...(rest as [() => void]));
          }) as typeof child.stdin.write;
          return child;
        }) as unknown as typeof nodeSpawn,
      });
      const sessionId = randomUUID();
      const owned = runtime.launch({
        externalInstanceId: 'owned-runtime-real-1',
        sessionId,
        cwd: 'F:/agent_test/agent-fleet-claude-integration-workspace',
        command: process.env.CLAUDE_FLEET_CLAUDE_COMMAND ?? 'claude',
        args: [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--replay-user-messages',
          '--include-hook-events',
          '--session-id',
          sessionId,
          '--model',
          'deepseek-v4-flash',
        ],
        terminalName: 'Claude Owned · owned-runtime-test-1',
        inputFormat: 'stream-json',
        env: {
          ...process.env,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        },
        showTerminal: false,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'result') exitResolve?.();
        },
        onExit: () => exitResolve?.(),
      });

      terminalOptions.pty?.onDidWrite((chunk) => rendered.push(chunk));
      terminalOptions.pty?.open?.();

      owned.submit('Respond with exactly OWNED_RUNTIME_OK');
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('real owned runtime probe timed out')), 90_000),
        ),
      ]);

      const result = events.find((event) => event.type === 'result');
      const assistant = events.find(
        (event) => event.type === 'assistant' && JSON.stringify(event).includes('OWNED_RUNTIME_OK'),
      );
      const userEvents = events.filter((event) => event.type === 'user');
      const eventSessionIds = events
        .map((event) => event.session_id)
        .filter((value): value is string => typeof value === 'string');
      const resultText = result && typeof result.result === 'string' ? result.result : '';
      const assistantText = assistant ? JSON.stringify(assistant) : '';

      expect(childWrites).toHaveLength(1);
      expect(events.some((event) => event.type === 'system')).toBe(true);
      expect(userEvents).toHaveLength(1);
      expect(eventSessionIds.length).toBeGreaterThan(0);
      expect(new Set(eventSessionIds)).toEqual(new Set([sessionId]));
      expect(assistantText).toContain('OWNED_RUNTIME_OK');
      expect(result).toMatchObject({ subtype: 'success' });
      expect(resultText).toBe('OWNED_RUNTIME_OK');
      expect(result && typeof result.usage === 'object').toBe(true);
      expect(result && typeof result.total_cost_usd === 'number').toBe(true);
      expect(rendered.join('')).toContain('OWNED_RUNTIME_OK');
      expect(rendered.join('')).toContain('[completed]');

      await owned.stop();
      expect(runtime.get('owned-runtime-real-1')).toBeUndefined();
    },
    120_000,
  );

  it.skipIf(process.env.CLAUDE_FLEET_REAL_OWNED_RUNTIME !== '1')(
    'keeps one owned Claude process alive for a second stream-json turn',
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the gated real probe.');

      const events: Record<string, unknown>[] = [];
      const created = terminal();
      const runtime = new ClaudeOwnedRuntime({
        createTerminal: vi.fn(() => created as never),
        spawn: nodeSpawn as typeof nodeSpawn,
      });
      const sessionId = randomUUID();
      const owned = runtime.launch({
        externalInstanceId: 'owned-runtime-real-second-turn',
        sessionId,
        cwd: 'F:/agent_test/agent-fleet-claude-integration-workspace',
        command: process.env.CLAUDE_FLEET_CLAUDE_COMMAND ?? 'claude',
        args: [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--replay-user-messages',
          '--include-hook-events',
          '--session-id',
          sessionId,
          '--model',
          'deepseek-v4-flash',
        ],
        terminalName: 'Claude Owned · second-turn-test',
        inputFormat: 'stream-json',
        env: {
          ...process.env,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        },
        showTerminal: false,
        onEvent: (event) => events.push(event),
      });

      const waitForResult = (marker: string): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error(`second-turn probe timed out waiting for ${marker}`)),
            90_000,
          );
          const poll = setInterval(() => {
            const result = events.find(
              (event) => event.type === 'result' && event.result === marker,
            );
            if (!result) return;
            clearTimeout(deadline);
            clearInterval(poll);
            resolve(result);
          }, 50);
        });

      try {
        owned.submit('Respond with exactly OWNED_FIRST_TURN_OK');
        await waitForResult('OWNED_FIRST_TURN_OK');
        expect(owned.alive).toBe(true);

        owned.submit('Respond with exactly OWNED_SECOND_TURN_OK');
        await waitForResult('OWNED_SECOND_TURN_OK');

        const sessionIds = events
          .map((event) => event.session_id)
          .filter((value): value is string => typeof value === 'string');
        expect(new Set(sessionIds)).toEqual(new Set([sessionId]));
        expect(events.filter((event) => event.type === 'user')).toHaveLength(2);
        expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
      } finally {
        await owned.stop();
      }
    },
    190_000,
  );
});
