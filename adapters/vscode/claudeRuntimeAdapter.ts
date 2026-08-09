import type { FleetEvent } from '../../core/src/fleetTelemetry.js';
import type {
  FleetInstance,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import { type CliResolverOptions, resolveClaudeCli } from '../../server/src/cliResolver.js';
import { claudeProvider } from '../../server/src/providers/index.js';

export interface ClaudeLaunchSpec {
  runtime: 'claude-code';
  command: string;
  args: string[];
  cwd: string;
  sessionMode: RuntimeLaunchRequest['sessionMode'];
  sessionId?: string;
}

export interface ClaudeRuntimeAdapterOptions extends CliResolverOptions {
  launch?: (
    request: RuntimeLaunchRequest,
    spec: ClaudeLaunchSpec,
  ) => Promise<{
    instanceId: string;
    sessionId?: string;
    startedAt: number;
  }>;
}

/**
 * Runtime-neutral facade for the native Claude Code CLI.
 *
 * The VS Code FleetRuntimeHost still owns the actual terminal launch and
 * lifecycle. This adapter contributes detection and native launch-spec
 * construction so the ControlService can use the same runtime boundary.
 */
export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = 'claude-code' as const;
  readonly displayName = 'Claude Code CLI';
  readonly capabilities: RuntimeCapabilities = {
    launch: true,
    stop: false,
    focus: false,
    restart: false,
    resume: true,
    discover: false,
    structuredEvents: false,
    nativeSessionContinuity: true,
  };

  private readonly resolverOptions: CliResolverOptions;
  private readonly launchExecutor: ClaudeRuntimeAdapterOptions['launch'];

  constructor(options: ClaudeRuntimeAdapterOptions = {}) {
    this.resolverOptions = options;
    this.launchExecutor = options.launch;
  }

  async detect(): Promise<boolean> {
    return (await resolveClaudeCli(this.resolverOptions)).ok;
  }

  async getVersion(): Promise<string | undefined> {
    return (await resolveClaudeCli(this.resolverOptions)).version;
  }

  async buildLaunchSpec(request: RuntimeLaunchRequest): Promise<ClaudeLaunchSpec> {
    if (request.instance.runtime !== 'claude-code') {
      throw new Error('Claude adapter cannot launch runtime ' + request.instance.runtime + '.');
    }
    if (!request.cwd.trim()) throw new Error('Claude launch requires a non-empty cwd.');
    if (request.sessionMode === 'resume' && !request.sessionId?.trim()) {
      throw new Error('Claude resume requires a sessionId.');
    }
    const resolution = await resolveClaudeCli(this.resolverOptions);
    if (!resolution.ok) throw new Error(resolution.diagnostics);
    const sessionId = request.sessionId ?? request.instance.sessionId;
    const native = claudeProvider.buildLaunchCommand?.(sessionId ?? 'fleet-session', request.cwd, {
      modelId: request.modelId,
      sessionMode: request.sessionMode,
    });
    return {
      runtime: 'claude-code',
      command: resolution.command,
      args: native?.args ?? [],
      cwd: request.cwd,
      sessionMode: request.sessionMode,
      sessionId,
    };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    const spec = await this.buildLaunchSpec(request);
    if (!this.launchExecutor) {
      throw new Error('Claude launch execution is owned by FleetRuntimeHost.');
    }
    return this.launchExecutor(request, spec);
  }

  async stop(_instanceId: string): Promise<void> {
    throw new Error('Claude stop execution is owned by FleetRuntimeHost.');
  }

  async focus(_instanceId: string): Promise<void> {
    throw new Error('Claude focus execution is owned by FleetRuntimeHost.');
  }

  async restart(_request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    throw new Error('Claude restart execution is owned by FleetRuntimeHost.');
  }

  async resume(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    return this.launch({ ...request, sessionMode: 'resume' });
  }

  async discover(): Promise<ReadonlyArray<Partial<FleetInstance>>> {
    return [];
  }

  normalizeEvent(_input: unknown): FleetEvent | undefined {
    // Claude hooks/JSONL are normalized by AgentRuntime before they enter the
    // shared FleetEvent boundary. This adapter must not duplicate that parser.
    return undefined;
  }
}
