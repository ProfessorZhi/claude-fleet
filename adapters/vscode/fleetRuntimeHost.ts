import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeBootstrapListener,
  RuntimeBootstrapSnapshot,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
} from '../../core/src/runtimeContracts.js';
import { renderRuntimeTaskBrief } from '../../server/src/runtimeTaskDelivery.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';

export interface VscodeRuntimeLaunchRequest extends RuntimeLaunchRequest {
  runtime: 'claude-code';
  launchOptions: LaunchNewTerminalOptions;
}

export interface VscodeFleetRuntimeHostDependencies {
  launch(request: VscodeRuntimeLaunchRequest): Promise<RuntimeLaunchResult>;
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
  /** Injected terminal boundary; the host supplies only a validated brief. */
  sendText?(instanceId: string, text: string): void | Promise<void>;
  /**
   * Claude Code's interactive prompt is not ready at the same moment that
   * createTerminal() returns. Keep this injectable so tests can model the
   * startup window without sleeping for the production grace period.
   */
  startupGraceMs?: number;
}

const DEFAULT_STARTUP_GRACE_MS = 750;

function waitForStartupGrace(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
  readonly sendTask: FleetRuntimeHost['sendTask'];
  private readonly deliveredTaskKeys = new Set<string>();
  private readonly pendingTaskDeliveries = new Map<string, Promise<void>>();
  private readonly instanceGenerations = new Map<string, number>();
  private readonly bootstrapByInstance = new Map<string, RuntimeBootstrapSnapshot>();
  private readonly bootstrapListeners = new Set<RuntimeBootstrapListener>();
  private readonly startupGraceMs: number;

  constructor(private readonly dependencies: VscodeFleetRuntimeHostDependencies) {
    this.startupGraceMs = Math.max(0, dependencies.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS);
    this.sendTask = dependencies.sendText
      ? async (instanceId: string, task: RuntimeTaskBrief): Promise<void> => {
          const key = `${instanceId}:${task.workItemId}`;
          if (this.deliveredTaskKeys.has(key)) return;
          const pending = this.pendingTaskDeliveries.get(key);
          if (pending) {
            await pending;
            return;
          }

          const generation = this.instanceGenerations.get(instanceId) ?? 0;
          const delivery = (async () => {
            // A terminal can exist while Claude Code is still starting its
            // interactive prompt. Queue the bounded brief instead of racing
            // the shell and losing the first message.
            await waitForStartupGrace(this.startupGraceMs);
            if ((this.instanceGenerations.get(instanceId) ?? 0) !== generation) {
              throw new Error('Runtime task delivery was cancelled by instance lifecycle.');
            }
            await dependencies.sendText!(instanceId, renderRuntimeTaskBrief(task));
            this.deliveredTaskKeys.add(key);
          })();

          this.pendingTaskDeliveries.set(key, delivery);
          delivery.then(
            () => this.pendingTaskDeliveries.delete(key),
            () => this.pendingTaskDeliveries.delete(key),
          );
          await delivery;
        }
      : undefined;
  }

  async launch(request: VscodeRuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.assertManagedClaudeRequest(request);
    this.resetInstanceDelivery(request.instance.instanceId);
    this.setBootstrapStatus(request.instance.instanceId, {
      state: 'starting',
      reason: 'startup_interaction',
      detail: 'Waiting for Claude Code startup evidence.',
      observedAt: Date.now(),
    });
    return this.dependencies.launch(request);
  }

  stop(instanceId: string): Promise<void> {
    this.resetInstanceDelivery(instanceId);
    this.setBootstrapStatus(instanceId, { state: 'stopped', observedAt: Date.now() });
    return this.dependencies.stop(instanceId);
  }

  focus(instanceId: string): Promise<void> {
    return this.dependencies.focus(instanceId);
  }

  getBootstrapStatus(instanceId: string): RuntimeBootstrapSnapshot | undefined {
    const snapshot = this.bootstrapByInstance.get(instanceId);
    return snapshot ? { ...snapshot } : undefined;
  }

  subscribeBootstrap(listener: RuntimeBootstrapListener): () => void {
    this.bootstrapListeners.add(listener);
    return () => this.bootstrapListeners.delete(listener);
  }

  /** Called by the VS Code projection when process/session evidence changes. */
  setBootstrapStatus(instanceId: string, snapshot: RuntimeBootstrapSnapshot): void {
    const previous = this.bootstrapByInstance.get(instanceId);
    this.bootstrapByInstance.set(instanceId, { ...snapshot });
    if (
      previous?.state === snapshot.state &&
      previous?.reason === snapshot.reason &&
      previous?.detail === snapshot.detail
    ) {
      return;
    }
    for (const listener of this.bootstrapListeners) listener(instanceId, { ...snapshot });
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

  private resetInstanceDelivery(instanceId: string): void {
    this.instanceGenerations.set(instanceId, (this.instanceGenerations.get(instanceId) ?? 0) + 1);
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
  displayName?: string;
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
    requestedProviderProfileId: args.providerProfileId,
    requestedModelId: args.modelId,
    displayName: args.displayName,
    automationMode: 'interactive',
    permissionMode: 'default',
    bootstrap: { state: 'starting', observedAt: now },
    launchSource: args.launchSource,
    requestedBy: args.requestedBy,
    fleet: args.fleet,
    createdAt: now,
    lastActivityAt: now,
  };
}
