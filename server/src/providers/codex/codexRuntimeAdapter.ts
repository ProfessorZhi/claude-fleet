import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import type { FleetEvent } from '../../../../core/src/fleetTelemetry.js';
import type {
  FleetInstance,
  FleetRuntime,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
} from '../../../../core/src/runtimeContracts.js';
import { execCaptured } from '../../cliResolver.js';

export interface CodexFileSystem {
  existsSync(path: string): boolean;
}

export interface CodexPathModule {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
}

export interface CodexCliResolution {
  ok: boolean;
  command: string;
  version?: string;
  source: 'path' | 'not-found';
  searchedPaths: string[];
  candidateNames: string[];
  diagnostics: string;
}

export interface CodexCliResolverOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  fs?: CodexFileSystem;
  path?: CodexPathModule;
  verify?: (command: string) => Promise<string>;
}

export interface CodexLaunchSpec {
  runtime: 'codex-cli';
  command: string;
  args: string[];
  cwd: string;
  sessionMode: RuntimeLaunchRequest['sessionMode'];
  sessionId?: string;
}

export interface CodexRuntimeAdapterOptions extends CodexCliResolverOptions {
  now?: () => number;
  launch?: (request: RuntimeLaunchRequest, spec: CodexLaunchSpec) => Promise<RuntimeLaunchResult>;
  /**
   * Optional management boundary supplied by the embedding host.
   *
   * The adapter never discovers or controls a process on its own. Capability
   * flags are derived from this boundary so a server-only adapter fails closed
   * instead of claiming it can manage terminals it cannot reach.
   */
  host?: CodexRuntimeHostBoundary;
}

export interface CodexRuntimeHostBoundary {
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
  sendTask?(instanceId: string, task: RuntimeTaskBrief): Promise<void>;
  restart?(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  resume?(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  discover?(): Promise<ReadonlyArray<Partial<FleetInstance>>>;
}

export class CodexRuntimeUnsupportedError extends Error {
  readonly code = 'CODEX_RUNTIME_UNSUPPORTED';

  constructor(operation: string) {
    super('Codex CLI ' + operation + ' requires an injected RuntimeHost/Terminal boundary.');
    this.name = 'CodexRuntimeUnsupportedError';
  }
}

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function ownString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text
    .replace(SECRET_ASSIGNMENT_PATTERN, '[redacted]')
    .replace(BEARER_PATTERN, '[redacted]')
    .slice(0, 512);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function safeTimestamp(record: Record<string, unknown>, now: () => number): number {
  const raw = record.observed_at ?? record.observedAt ?? record.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now();
}

function safeEventId(record: Record<string, unknown>, sequence: number): string {
  const candidate = safeText(record.event_id ?? record.eventId);
  return candidate ? 'codex-' + candidate : 'codex-event-' + sequence;
}

const EVENT_TYPE_MAP: Readonly<Record<string, FleetEvent['eventType']>> = {
  session_started: 'session_started',
  'session.started': 'session_started',
  session_resumed: 'session_resumed',
  'session.resumed': 'session_resumed',
  agent_started: 'agent_started',
  agent_stopped: 'agent_stopped',
  tool_started: 'tool_started',
  'item.started': 'tool_started',
  tool_finished: 'tool_finished',
  'item.completed': 'tool_finished',
  task_started: 'task_started',
  'turn.started': 'task_started',
  task_finished: 'task_finished',
  'turn.completed': 'task_finished',
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
  error: 'error',
  context_updated: 'context_updated',
  handoff: 'handoff',
};

function normalizedType(record: Record<string, unknown>): FleetEvent['eventType'] | undefined {
  const type = ownString(record, 'type', 'event_type', 'eventType');
  return type ? EVENT_TYPE_MAP[type] : undefined;
}

function sessionIdOf(record: Record<string, unknown>): string | undefined {
  const nested = recordOf(record.session);
  const nestedId = nested ? ownString(nested, 'id') : undefined;
  return safeText(ownString(record, 'session_id', 'sessionId') ?? nestedId);
}

function contextUsageOf(record: Record<string, unknown>): FleetEvent['contextUsage'] | undefined {
  const context = recordOf(
    record.context_usage ?? record.contextUsage ?? record.context_window ?? record.contextWindow,
  );
  if (!context) return undefined;
  const usedTokens = numberValue(
    context,
    'used_tokens',
    'usedTokens',
    'context_tokens',
    'contextTokens',
  );
  const limitTokens = numberValue(
    context,
    'limit_tokens',
    'limitTokens',
    'max_context_tokens',
    'maxContextTokens',
  );
  return usedTokens === undefined && limitTokens === undefined
    ? undefined
    : { usedTokens, limitTokens };
}

function errorOf(
  record: Record<string, unknown>,
  observedAt: number,
): FleetEvent['error'] | undefined {
  const errorValue = recordOf(record.error);
  const rawMessage =
    typeof record.error === 'string'
      ? record.error
      : errorValue
        ? ownString(errorValue, 'message', 'detail')
        : ownString(record, 'message', 'detail');
  const message = safeText(rawMessage);
  return message ? { message, timestamp: observedAt, source: 'codex-jsonl' } : undefined;
}

function parseInput(input: unknown): Record<string, unknown>[] {
  if (typeof input === 'string') {
    return input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = recordOf(JSON.parse(line));
          return record ? [record] : [];
        } catch {
          return [];
        }
      });
  }
  const record = recordOf(input);
  return record ? [record] : [];
}

export function codexCandidateNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
}

function codexVersionParts(version: string): [number, number, number] | undefined {
  const match = /(?:codex(?:-cli)?\s*)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function isNewerCodexVersion(candidate: string, current: string): boolean {
  const candidateParts = codexVersionParts(candidate);
  const currentParts = codexVersionParts(current);
  if (candidateParts && !currentParts) return true;
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export async function resolveCodexCli(
  options: CodexCliResolverOptions = {},
): Promise<CodexCliResolution> {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const fileSystem = options.fs ?? nodeFs;
  const pathModule = options.path ?? nodePath;
  const verify =
    options.verify ??
    ((command: string) => execCaptured(command, ['--version'], { platform, timeout: 15_000 }));
  const candidateNames = codexCandidateNames(platform);
  const searchedPaths: string[] = [];
  const seen = new Set<string>();

  for (const entry of pathEnv.split(pathDelimiter(platform))) {
    const directory = entry.trim();
    if (!directory) continue;
    const key = pathModule.resolve(directory);
    if (seen.has(key)) continue;
    seen.add(key);
    searchedPaths.push(directory);
  }

  let best: { command: string; version: string } | undefined;
  for (const directory of searchedPaths) {
    for (const candidateName of candidateNames) {
      const command = pathModule.join(directory, candidateName);
      if (!fileSystem.existsSync(command)) continue;
      try {
        const version = await verify(command);
        if (!version.trim()) continue;
        const normalizedVersion = version.trim();
        if (!best || isNewerCodexVersion(normalizedVersion, best.version)) {
          best = { command, version: normalizedVersion };
        }
      } catch {
        // Continue after a broken candidate.
      }
    }
  }

  if (best) {
    return {
      ok: true,
      command: best.command,
      version: best.version,
      source: 'path',
      searchedPaths,
      candidateNames,
      diagnostics: 'Codex CLI resolved: ' + best.command + ' (' + best.version + ')',
    };
  }

  return {
    ok: false,
    command: 'codex',
    source: 'not-found',
    searchedPaths,
    candidateNames,
    diagnostics: [
      'Codex CLI not found.',
      'Searched candidates: ' + candidateNames.join(', '),
      'PATH entries searched: ' + searchedPaths.length,
    ].join('\n'),
  };
}

let eventSequence = 0;

export function normalizeCodexEvents(input: unknown, now = Date.now): FleetEvent[] {
  return parseInput(input).flatMap((record) => {
    const eventType = normalizedType(record);
    if (!eventType) return [];

    const item = recordOf(record.item);
    const observedAt = safeTimestamp(record, now);
    const event: FleetEvent = {
      eventId: safeEventId(record, ++eventSequence),
      eventType,
      observedAt,
      source: 'external',
      runtime: 'codex-cli',
      instanceId: safeText(ownString(record, 'instance_id', 'instanceId')),
      managedByFleet:
        booleanValue(record, 'managed_by_fleet') ?? booleanValue(record, 'managedByFleet'),
      repo: safeText(ownString(record, 'repo', 'repository')),
      cwd: safeText(ownString(record, 'cwd', 'working_directory')),
      hostId: safeText(ownString(record, 'host_id', 'hostId')),
      workspaceId: safeText(ownString(record, 'workspace_id', 'workspaceId')),
      terminalId: safeText(ownString(record, 'terminal_id', 'terminalId')),
      terminalName: safeText(ownString(record, 'terminal_name', 'terminalName')),
      launchSource: safeText(ownString(record, 'launch_source', 'launchSource')),
      requestedBy: safeText(ownString(record, 'requested_by', 'requestedBy')),
      sessionId: sessionIdOf(record),
      modelId: safeText(ownString(record, 'model_id', 'modelId', 'model')),
      status: safeText(ownString(record, 'status')),
      currentTool: safeText(
        ownString(record, 'current_tool', 'currentTool') ??
          (item ? ownString(item, 'type', 'kind') : undefined),
      ),
      currentTask: safeText(ownString(record, 'current_task', 'currentTask', 'task', 'title')),
      contextUsage: contextUsageOf(record),
    };

    const role = safeText(ownString(record, 'role'));
    if (
      role === 'coordinator' ||
      role === 'worker' ||
      role === 'reviewer' ||
      role === 'debugger' ||
      role === 'researcher' ||
      role === 'planner' ||
      role === 'tester' ||
      role === 'subagent' ||
      role === 'external'
    ) {
      event.role = role;
    }

    const agentId = numberValue(record, 'agent_id', 'agentId');
    if (agentId !== undefined && Number.isInteger(agentId)) event.agentId = agentId;
    const parentAgentId = safeText(ownString(record, 'parent_agent_id', 'parentAgentId'));
    const leadAgentId = safeText(ownString(record, 'lead_agent_id', 'leadAgentId'));
    if (parentAgentId) event.parentAgentId = parentAgentId;
    if (leadAgentId) event.leadAgentId = leadAgentId;
    if (eventType === 'error') {
      const error = errorOf(record, observedAt);
      if (error) event.error = error;
    }
    return [event];
  });
}

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: FleetRuntime = 'codex-cli';
  readonly displayName = 'Codex CLI';

  private readonly resolverOptions: CodexCliResolverOptions;
  private readonly now: () => number;
  private readonly launchExecutor:
    | ((request: RuntimeLaunchRequest, spec: CodexLaunchSpec) => Promise<RuntimeLaunchResult>)
    | undefined;
  private controlHost: CodexRuntimeHostBoundary | undefined;

  constructor(options: CodexRuntimeAdapterOptions = {}) {
    this.resolverOptions = options;
    this.now = options.now ?? (() => Date.now());
    this.launchExecutor = options.launch;
    this.controlHost = options.host;
  }

  /** Attach the host after construction when the host owns this adapter. */
  attachHost(host: CodexRuntimeHostBoundary | undefined): void {
    this.controlHost = host;
  }

  get capabilities(): RuntimeCapabilities {
    const host = this.controlHost;
    return {
      launch: true,
      stop: host !== undefined,
      focus: host !== undefined,
      restart: typeof host?.restart === 'function',
      resume: typeof host?.resume === 'function',
      discover: typeof host?.discover === 'function',
      structuredEvents: true,
      nativeSessionContinuity: true,
    };
  }

  async resolveExecutable(): Promise<CodexCliResolution> {
    return resolveCodexCli(this.resolverOptions);
  }

  async detect(): Promise<boolean> {
    return (await this.resolveExecutable()).ok;
  }

  async getVersion(): Promise<string | undefined> {
    return (await this.resolveExecutable()).version;
  }

  async buildLaunchSpec(request: RuntimeLaunchRequest): Promise<CodexLaunchSpec> {
    if (request.instance.runtime !== 'codex-cli') {
      throw new Error('Codex adapter cannot launch runtime ' + request.instance.runtime + '.');
    }
    if (!request.cwd.trim()) throw new Error('Codex launch requires a non-empty cwd.');
    if (request.sessionMode === 'resume' && !request.sessionId?.trim()) {
      throw new Error('Codex resume requires a sessionId.');
    }

    const resolution = await this.resolveExecutable();
    if (!resolution.ok) throw new Error(resolution.diagnostics);

    const args: string[] = [];
    if (request.modelId?.trim()) args.push('--model', request.modelId.trim());
    if (request.sessionMode === 'resume') args.push('resume', request.sessionId!.trim());

    return {
      runtime: 'codex-cli',
      command: resolution.command,
      args,
      cwd: request.cwd,
      sessionMode: request.sessionMode,
      sessionId: request.sessionId,
    };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    const spec = await this.buildLaunchSpec(request);
    if (!this.launchExecutor) throw new CodexRuntimeUnsupportedError('launch execution');
    return this.launchExecutor(request, spec);
  }

  async stop(_instanceId: string): Promise<void> {
    const host = this.controlHost;
    if (!host) throw new CodexRuntimeUnsupportedError('stop');
    return host.stop(_instanceId);
  }

  async focus(instanceId: string): Promise<void> {
    const host = this.controlHost;
    if (!host) throw new CodexRuntimeUnsupportedError('focus');
    return host.focus(instanceId);
  }

  async restart(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    const restart = this.controlHost?.restart;
    if (!restart) throw new CodexRuntimeUnsupportedError('restart');
    return restart(request);
  }

  async resume(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    const resume = this.controlHost?.resume;
    if (!resume) throw new CodexRuntimeUnsupportedError('resume');
    return resume(request);
  }

  async discover(): Promise<ReadonlyArray<Partial<FleetInstance>>> {
    const discover = this.controlHost?.discover;
    if (!discover) throw new CodexRuntimeUnsupportedError('discover');
    return discover();
  }

  normalizeEvent(input: unknown): FleetEvent | undefined {
    return normalizeCodexEvents(input, this.now)[0];
  }

  normalizeEvents(input: unknown): FleetEvent[] {
    return normalizeCodexEvents(input, this.now);
  }
}
