import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';

export interface VscodeRuntimeLaunchRequest extends RuntimeLaunchRequest {
  runtime: 'claude-code';
  launchOptions: LaunchNewTerminalOptions;
}

export interface VscodeFleetRuntimeHostDependencies {
  launch(request: VscodeRuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
}

/**
 * VS Code Integrated Terminal host boundary for Fleet-managed Claude Code.
 *
 * The native launch implementation is injected so the current Agent Manager
 * can be adopted without changing its Provider/Session behavior. The host
 * owns the management-plane checks and becomes the single entry point for
 * managed launches.
 */
export class VscodeFleetRuntimeHost implements FleetRuntimeHost<VscodeRuntimeLaunchRequest> {
  readonly hostId = 'vscode-integrated-terminal';
  readonly hostType = 'vscode-integrated-terminal';

  constructor(private readonly dependencies: VscodeFleetRuntimeHostDependencies) {}

  async launch(request: VscodeRuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.assertManagedClaudeRequest(request);
    return this.dependencies.launch(request);
  }

  stop(instanceId: string): Promise<void> {
    return this.dependencies.stop(instanceId);
  }

  focus(instanceId: string): Promise<void> {
    return this.dependencies.focus(instanceId);
  }

  private assertManagedClaudeRequest(request: VscodeRuntimeLaunchRequest): void {
    if (request.runtime !== 'claude-code' || request.instance.runtime !== 'claude-code') {
      throw new Error('VscodeFleetRuntimeHost only manages Claude Code in the current phase.');
    }
    if (!request.instance.managedByFleet) {
      throw new Error('VscodeFleetRuntimeHost cannot launch an external instance.');
    }
    if (!request.cwd) {
      throw new Error('VscodeFleetRuntimeHost requires a workspace cwd.');
    }
  }
}

export function makeClaudeFleetInstance(args: {
  instanceId: string;
  cwd: string;
  role?: FleetInstance['role'];
  missionId?: string;
  workItemId?: string;
  sessionId?: string;
  providerProfileId?: string;
  modelId?: string;
  launchSource?: string;
  requestedBy?: string;
  fleet?: FleetInstance['fleet'];
}): FleetInstance {
  const now = Date.now();
  return {
    instanceId: args.instanceId,
    runtime: 'claude-code',
    role: args.role ?? 'worker',
    managedByFleet: true,
    missionId: args.missionId,
    workItemId: args.workItemId,
    sessionId: args.sessionId,
    hostId: 'vscode-integrated-terminal',
    workspaceId: args.cwd,
    terminalId: `terminal-${args.instanceId}`,
    repo: args.cwd,
    status: args.sessionId ? 'working' : 'starting',
    providerProfileId: args.providerProfileId,
    modelId: args.modelId,
    launchSource: args.launchSource,
    requestedBy: args.requestedBy,
    fleet: args.fleet,
    createdAt: now,
    lastActivityAt: now,
  };
}
