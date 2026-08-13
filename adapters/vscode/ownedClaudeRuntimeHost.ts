import { randomUUID } from 'node:crypto';

import type {
  FleetRuntimeHost,
  RuntimeBootstrapListener,
  RuntimeBootstrapSnapshot,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
  RuntimeTaskDeliveryDiagnostics,
} from '../../core/src/runtimeContracts.js';
import { resolveClaudeCli } from '../../server/src/cliResolver.js';
import { getClaudeConfigDir } from '../../server/src/providers/hook/claude/claudeConfigPath.js';
import { renderRuntimeTaskBrief } from '../../server/src/runtimeTaskDelivery.js';
import { resolveLaunchConfigFromStore } from './agentManager.js';
import { ClaudeOwnedRuntime, type ClaudeOwnedRuntimeProcess } from './claudeOwnedRuntime.js';
import type { ProviderProfileStore } from './providerProfileStore.js';
import type { SecretStorageProvider } from './secretStorageProvider.js';

export interface OwnedClaudeRuntimeHostCallbacks {
  onLaunch: (instanceId: string, result: RuntimeLaunchResult) => void;
  onEvent: (instanceId: string, sessionId: string, event: Record<string, unknown>) => void;
  onExit: (instanceId: string, sessionId: string, exitCode: number | null) => void;
}

/**
 * Feature-gated Fleet host for the Claude stream-json process owner.
 *
 * The control plane sees only the FleetRuntimeHost contract. Claude's
 * provider env, CLI flags and NDJSON shape stay inside this adapter boundary.
 */
export class OwnedClaudeRuntimeHost implements FleetRuntimeHost {
  readonly hostId = 'vscode-owned-claude-runtime';
  readonly hostType = 'vscode-owned-claude-runtime';
  readonly sendTask: FleetRuntimeHost['sendTask'];

  private readonly processes = new Map<string, ClaudeOwnedRuntimeProcess>();
  private readonly bootstrap = new Map<string, RuntimeBootstrapSnapshot>();
  private readonly listeners = new Set<RuntimeBootstrapListener>();
  private readonly sendCounts = new Map<string, number>();

  constructor(
    private readonly runtime: ClaudeOwnedRuntime,
    private readonly providerProfileStore: ProviderProfileStore,
    private readonly secretStorageProvider: SecretStorageProvider,
    private readonly callbacks: OwnedClaudeRuntimeHostCallbacks,
  ) {
    this.sendTask = async (instanceId: string, task: RuntimeTaskBrief): Promise<void> => {
      const process = this.processes.get(instanceId);
      if (!process || !process.alive) throw new Error('Owned Claude process is unavailable.');
      const key = `${instanceId}:${task.workItemId}`;
      const count = (this.sendCounts.get(key) ?? 0) + 1;
      if (count > 1) return;
      // The task boundary is validated before it reaches this host. The
      // objective remains bounded but the user-facing prompt stays concise so
      // exact-marker WorkItems can return the requested marker exactly.
      process.submit(task.objective || renderRuntimeTaskBrief(task));
      this.sendCounts.set(key, count);
    };
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    if (request.instance.runtime !== 'claude-code') {
      throw new Error('Owned Claude host only accepts Claude Code instances.');
    }
    const instanceId = request.instance.instanceId;
    const sessionId = request.sessionId ?? request.instance.sessionId ?? randomUUID();
    const launchConfig = await resolveLaunchConfigFromStore({
      launchConfig: {
        cwd: request.cwd,
        providerProfileId: request.providerProfileId ?? '',
        modelId: request.modelId,
        fleet: request.instance.fleet,
      },
      providerProfileStore: this.providerProfileStore,
      secretStorageProvider: this.secretStorageProvider,
      sessionId,
      permissionMode: request.permissionMode,
    });
    const cli = await resolveClaudeCli();
    if (!cli.ok) throw new Error(cli.diagnostics);

    const args = [
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
    ];
    if (launchConfig.safeMetadata.modelId) {
      args.push('--model', launchConfig.safeMetadata.modelId);
    }
    if (request.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    }

    this.setBootstrap(instanceId, {
      state: 'starting',
      reason: 'startup_interaction',
      detail: 'Waiting for Claude stream initialization.',
      observedAt: Date.now(),
    });
    const process = this.runtime.launch({
      externalInstanceId: instanceId,
      sessionId,
      cwd: request.cwd,
      command: cli.command,
      args,
      terminalName:
        request.terminalName ?? `Claude Owned · ${request.instance.displayName ?? instanceId}`,
      inputFormat: 'stream-json',
      env: {
        ...launchConfig.env,
        CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
      },
      showTerminal: true,
      onEvent: (event) => this.callbacks.onEvent(instanceId, sessionId, event),
      onExit: (exitCode) => this.callbacks.onExit(instanceId, sessionId, exitCode),
    });
    this.processes.set(instanceId, process);
    const result: RuntimeLaunchResult = {
      instanceId,
      transport: 'owned',
      sessionId,
      terminalId: `terminal-${instanceId}`,
      terminalName: process.terminalName,
      hostId: this.hostId,
      workspaceId: request.cwd,
      launchSource: request.launchSource,
      requestedBy: request.requestedBy,
      ...launchConfig.safeMetadata,
      startedAt: Date.now(),
    };
    this.callbacks.onLaunch(instanceId, result);
    return result;
  }

  async stop(instanceId: string): Promise<void> {
    this.setBootstrap(instanceId, { state: 'stopped', observedAt: Date.now() });
    await this.runtime.stop(instanceId);
    this.processes.delete(instanceId);
  }

  async focus(instanceId: string): Promise<void> {
    const process = this.processes.get(instanceId);
    if (!process) throw new Error('Owned Claude process is unavailable.');
    process.focus();
  }

  getBootstrapStatus(instanceId: string): RuntimeBootstrapSnapshot | undefined {
    const snapshot = this.bootstrap.get(instanceId);
    return snapshot ? { ...snapshot } : undefined;
  }

  subscribeBootstrap(listener: RuntimeBootstrapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDeliveryDiagnostics(instanceId: string, workItemId?: string): RuntimeTaskDeliveryDiagnostics {
    const key = workItemId ? `${instanceId}:${workItemId}` : undefined;
    return {
      instanceId,
      ...(workItemId ? { workItemId } : {}),
      sendTaskCallCount: key ? (this.sendCounts.get(key) ?? 0) : 0,
      renderedBriefByteLength: undefined,
      terminalRef: 'present',
      terminalExitStatus: this.processes.get(instanceId)?.alive ? 'running' : 'exited',
      addNewLine: 'unknown',
    };
  }

  setBootstrapStatus(instanceId: string, snapshot: RuntimeBootstrapSnapshot): void {
    this.setBootstrap(instanceId, snapshot);
  }

  private setBootstrap(instanceId: string, snapshot: RuntimeBootstrapSnapshot): void {
    const previous = this.bootstrap.get(instanceId);
    this.bootstrap.set(instanceId, { ...snapshot });
    if (
      previous?.state === snapshot.state &&
      previous?.reason === snapshot.reason &&
      previous?.detail === snapshot.detail
    ) {
      return;
    }
    for (const listener of this.listeners) listener(instanceId, { ...snapshot });
  }
}
