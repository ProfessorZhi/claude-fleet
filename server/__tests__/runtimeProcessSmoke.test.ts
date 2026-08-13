import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCodeRuntimeAdapter } from '../../adapters/vscode/claudeRuntimeAdapter.js';
import { VscodeFleetRuntimeHost } from '../../adapters/vscode/fleetRuntimeHost.js';
import type {
  RuntimeLaunchRequest,
  RuntimeTaskBrief,
  WorkItemResult,
} from '../../core/src/runtimeContracts.js';
import { CodexFleetRuntimeHost } from '../src/providers/codex/codexFleetRuntimeHost.js';
import { CodexRuntimeAdapter } from '../src/providers/codex/codexRuntimeAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { deliverRuntimeTask } from '../src/runtimeTaskDelivery.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../scripts/smoke/fixtures');
const CLAUDE_FIXTURE = path.join(FIXTURE_DIR, 'claude');
const CODEX_FIXTURE = path.join(FIXTURE_DIR, 'codex');

type JsonRecord = Record<string, unknown>;

interface FakeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  readonly exit: Promise<number | null>;
  nextLine(predicate?: (value: JsonRecord) => boolean): Promise<JsonRecord>;
}

class ProcessBridge {
  readonly launches: Array<{ instanceId: string; command: string; args: string[] }> = [];
  readonly focused: string[] = [];
  private readonly processes = new Map<string, FakeProcess>();

  async launch(
    instanceId: string,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ instanceId: string; sessionId?: string; startedAt: number }> {
    const child = spawn(process.execPath, [command, ...args], {
      cwd,
      env: { ...process.env, NO_PROXY: '*', no_proxy: '*' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines: string[] = [];
    const waiters: Array<{
      predicate: (value: JsonRecord) => boolean;
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        lines.push(line);
        let value: JsonRecord;
        try {
          value = JSON.parse(line) as JsonRecord;
        } catch {
          continue;
        }
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (!waiters[index].predicate(value)) continue;
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(value);
          break;
        }
      }
    });
    const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
    const processHandle: FakeProcess = {
      child,
      lines,
      exit,
      nextLine: (predicate = () => true) =>
        new Promise<JsonRecord>((resolve, reject) => {
          for (const line of lines) {
            try {
              const value = JSON.parse(line) as JsonRecord;
              if (predicate(value)) {
                resolve(value);
                return;
              }
            } catch {
              // The fixture only emits JSON, but malformed output is ignored.
            }
          }
          const timer = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.timer === timer);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for fake ${instanceId} event.`));
          }, 5_000);
          waiters.push({ predicate, resolve, reject, timer });
        }),
    };
    this.processes.set(instanceId, processHandle);
    this.launches.push({ instanceId, command, args: [...args] });

    const started = await processHandle.nextLine(
      (value) => value.type === 'session.started' || value.hook_event_name === 'SessionStart',
    );
    return {
      instanceId,
      sessionId: typeof started.session_id === 'string' ? started.session_id : undefined,
      startedAt: 1_700_000_000_000,
    };
  }

  sendText(instanceId: string, text: string): void {
    const processHandle = this.processes.get(instanceId);
    if (!processHandle) throw new Error('fake process is not running');
    processHandle.child.stdin.write(`${text}\n`);
  }

  async stop(instanceId: string): Promise<void> {
    const processHandle = this.processes.get(instanceId);
    if (!processHandle) return;
    processHandle.child.stdin.write('{"type":"fleet.control","action":"stop"}\n');
    await processHandle.exit;
    this.processes.delete(instanceId);
  }

  focus(instanceId: string): void {
    this.focused.push(instanceId);
  }

  process(instanceId: string): FakeProcess {
    const processHandle = this.processes.get(instanceId);
    if (!processHandle) throw new Error(`fake process ${instanceId} is not running`);
    return processHandle;
  }

  async dispose(): Promise<void> {
    for (const instanceId of [...this.processes.keys()]) {
      const processHandle = this.processes.get(instanceId);
      if (!processHandle) continue;
      processHandle.child.kill();
      await processHandle.exit;
      this.processes.delete(instanceId);
    }
  }
}

const task: RuntimeTaskBrief = {
  workItemId: 'work-runtime-smoke',
  title: 'Verify bounded runtime delivery',
  objective: 'Exercise a deterministic process without sending a real prompt.',
  acceptanceCriteria: ['The process receives only the rendered Fleet brief.'],
};

function fixtureFileSystem(command: string): Pick<typeof fs, 'existsSync'> {
  return {
    existsSync: (candidate) => {
      const value = typeof candidate === 'string' ? candidate : String(candidate);
      return value === command;
    },
  };
}

async function probeFixture(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fake CLI --version failed (${String(code)}): ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseResult(value: JsonRecord): WorkItemResult {
  const expectedKeys = [
    'artifact_refs',
    'availability',
    'captured_at',
    'confidence',
    'instance_id',
    'outcome',
    'source',
    'summary',
    'type',
    'work_item_id',
  ].sort();
  expect(Object.keys(value).sort()).toEqual(expectedKeys);
  expect(value.type).toBe('fleet.result');
  return {
    workItemId: String(value.work_item_id),
    instanceId: String(value.instance_id),
    outcome: value.outcome as WorkItemResult['outcome'],
    summary: String(value.summary),
    artifactRefs: (value.artifact_refs as string[]).slice(),
    capturedAt: Number(value.captured_at),
    source: value.source as WorkItemResult['source'],
    availability: value.availability as WorkItemResult['availability'],
    confidence: value.confidence as WorkItemResult['confidence'],
  };
}

function request(runtime: 'claude-code' | 'codex-cli', instanceId: string): RuntimeLaunchRequest {
  return {
    instance: {
      instanceId,
      runtime,
      role: 'worker',
      managedByFleet: true,
      status: 'starting',
      sessionId: `${runtime}-session`,
      createdAt: 1_700_000_000_000,
    },
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-runtime-smoke-')),
    sessionMode: 'new',
  };
}

describe('Production Closure runtime process smoke', () => {
  const bridges: ProcessBridge[] = [];
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
    for (const workspace of workspaces.splice(0)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('probes and drives the Claude process contract without API or transcript access', async () => {
    const version = await probeFixture(CLAUDE_FIXTURE);
    expect(version).toBe('claude-fleet-fake 1.0.0');

    const bridge = new ProcessBridge();
    bridges.push(bridge);
    const instanceId = 'claude-code-smoke-instance';
    const launchRequest = request('claude-code', instanceId);
    workspaces.push(launchRequest.cwd);
    const adapter = new ClaudeCodeRuntimeAdapter({
      pathEnv: FIXTURE_DIR,
      fs: { existsSync: (candidate) => String(candidate) === CLAUDE_FIXTURE },
      npmBinDir: async () => undefined,
      verify: async (command) => probeFixture(command),
      launch: async (_request, spec) =>
        bridge.launch(instanceId, spec.command, spec.args, launchRequest.cwd),
    });
    const host = new VscodeFleetRuntimeHost({
      launch: (value) => adapter.launch(value),
      stop: (id) => bridge.stop(id),
      focus: async (id) => bridge.focus(id),
      sendText: (id, text) => bridge.sendText(id, text),
      startupGraceMs: 0,
    });

    const launched = await host.launch({
      ...launchRequest,
      runtime: 'claude-code',
      launchOptions: {} as never,
    });
    expect(launched).toMatchObject({ instanceId, sessionId: 'claude-code-session' });
    expect(bridge.launches[0]).toMatchObject({ command: CLAUDE_FIXTURE });
    expect(bridge.launches[0].args).toEqual(['--session-id', 'claude-code-session']);

    const rejectedSecret = await deliverRuntimeTask(
      host,
      {
        instanceId,
        task: { ...task, objective: 'secret=smoke-secret-must-not-cross' },
      },
      () => 1_700_000_000_122,
    );
    expect(rejectedSecret).toMatchObject({
      instanceId,
      workItemId: task.workItemId,
      status: 'rejected',
      reason: 'invalid_brief',
    });

    const delivery = await deliverRuntimeTask(host, { instanceId, task }, () => 1_700_000_000_123);
    expect(delivery).toMatchObject({
      instanceId,
      workItemId: task.workItemId,
      status: 'delivered',
      deliveredAt: 1_700_000_000_123,
    });

    const processHandle = bridge.process(instanceId);
    const resultLine = await processHandle.nextLine((value) => value.type === 'fleet.result');
    await processHandle.nextLine((value) => value.hook_event_name === 'Stop');
    const result = parseResult(resultLine);
    expect(result).toMatchObject({ workItemId: task.workItemId, instanceId, outcome: 'completed' });
    const normalizedKinds = processHandle.lines.flatMap((line) => {
      const value = JSON.parse(line) as JsonRecord;
      const normalized = claudeProvider.normalizeHookEvent(value);
      return normalized ? [normalized.event.kind] : [];
    });
    expect(normalizedKinds).toEqual(['sessionStart', 'toolStart', 'turnEnd']);
    expect(processHandle.lines.join('\n')).not.toContain('api_key');
    expect(processHandle.lines.join('\n')).not.toContain('smoke-secret-must-not-cross');
    expect(processHandle.lines.join('\n')).not.toContain('rawPrompt');
    expect(processHandle.lines.join('\n')).not.toContain('transcript');

    await host.focus(instanceId);
    expect(bridge.focused).toEqual([instanceId]);
    await host.stop(instanceId);
    expect(await processHandle.exit).toBe(0);

    // Claude's host owns restart; the adapter owns the native resume argv.
    const resumed = await adapter.resume({
      ...launchRequest,
      sessionMode: 'resume',
      sessionId: 'claude-code-session',
    });
    expect(resumed.instanceId).toBe(instanceId);
    expect(bridge.launches.at(-1)?.args).toEqual(['--resume', 'claude-code-session']);
    await bridge.stop(instanceId);
  });

  it('probes and drives the Codex process contract through launch/task/stop/restart/resume', async () => {
    const version = await probeFixture(CODEX_FIXTURE);
    expect(version).toBe('codex-fleet-fake 1.0.0');

    const bridge = new ProcessBridge();
    bridges.push(bridge);
    const instanceId = 'codex-cli-smoke-instance';
    const launchRequest = request('codex-cli', instanceId);
    workspaces.push(launchRequest.cwd);
    const adapter = new CodexRuntimeAdapter({
      pathEnv: FIXTURE_DIR,
      fs: fixtureFileSystem(CODEX_FIXTURE),
      path: process.platform === 'win32' ? path.win32 : path.posix,
      verify: async (command) => probeFixture(command),
      launch: async (_request, spec) =>
        bridge.launch(instanceId, spec.command, spec.args, launchRequest.cwd),
    });
    const host = new CodexFleetRuntimeHost(adapter, {
      stop: (id) => bridge.stop(id),
      focus: async (id) => bridge.focus(id),
      sendText: (id, text) => bridge.sendText(id, text),
    });

    const launched = await host.launch(launchRequest);
    expect(launched).toMatchObject({ instanceId, sessionId: 'codex-cli-session' });
    expect(bridge.launches[0].args).toEqual([]);

    const delivery = await deliverRuntimeTask(host, { instanceId, task }, () => 1_700_000_000_456);
    expect(delivery.status).toBe('delivered');
    const processHandle = bridge.process(instanceId);
    const resultLine = await processHandle.nextLine((value) => value.type === 'fleet.result');
    await processHandle.nextLine((value) => value.type === 'turn.completed');
    expect(parseResult(resultLine)).toMatchObject({
      workItemId: task.workItemId,
      instanceId,
      outcome: 'completed',
    });
    const normalizedEvents = processHandle.lines.flatMap((line) => adapter.normalizeEvents(line));
    expect(normalizedEvents.map((event) => event.eventType)).toEqual([
      'session_started',
      'task_started',
      'task_finished',
    ]);
    expect(processHandle.lines.join('\n')).not.toContain('api_key');
    expect(processHandle.lines.join('\n')).not.toContain('rawPrompt');
    expect(processHandle.lines.join('\n')).not.toContain('transcript');

    await host.focus(instanceId);
    expect(bridge.focused).toEqual([instanceId]);
    await expect(
      host.restart({ ...launchRequest, sessionId: 'codex-cli-session' }),
    ).resolves.toMatchObject({
      instanceId,
      sessionId: 'codex-cli-session',
    });
    expect(bridge.launches.at(-1)?.args).toEqual(['resume', 'codex-cli-session']);
    await host.stop(instanceId);
    await expect(
      host.resume({ ...launchRequest, sessionId: 'codex-cli-session' }),
    ).resolves.toMatchObject({
      instanceId,
      sessionId: 'codex-cli-session',
    });
    expect(bridge.launches.at(-1)?.args).toEqual(['resume', 'codex-cli-session']);
    const resumedProcess = bridge.process(instanceId);
    await host.stop(instanceId);
    expect(await resumedProcess.exit).toBe(0);
  });
});
