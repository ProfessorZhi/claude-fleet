import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  RuntimeTaskBrief,
} from '../../../../core/src/runtimeContracts.js';
import { renderRuntimeTaskBrief } from '../../runtimeTaskDelivery.js';
import { CodexRuntimeAdapter, type CodexRuntimeHostBoundary } from './codexRuntimeAdapter.js';

export interface CodexFleetRuntimeHostDependencies {
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
  /** Injected terminal boundary; the host supplies only a validated brief. */
  sendText?(instanceId: string, text: string): void | Promise<void>;
  discover?(): Promise<ReadonlyArray<Partial<FleetInstance>>>;
}

/**
 * Management host for a Fleet-owned Codex CLI instance.
 *
 * The adapter still owns native Codex command construction. The host owns the
 * Fleet-side managed/external boundary and terminal lifecycle callbacks. A
 * real process/terminal bridge is injected; this class never shells out by
 * itself.
 */
export class CodexFleetRuntimeHost implements FleetRuntimeHost, CodexRuntimeHostBoundary {
  readonly hostId = 'codex-cli-host';
  readonly hostType = 'codex-cli-host';
  readonly discover: (() => Promise<ReadonlyArray<Partial<FleetInstance>>>) | undefined;
  readonly sendTask: FleetRuntimeHost['sendTask'];

  constructor(
    private readonly adapter: CodexRuntimeAdapter,
    private readonly dependencies: CodexFleetRuntimeHostDependencies,
  ) {
    this.discover = dependencies.discover;
    this.sendTask = dependencies.sendText
      ? async (instanceId: string, task: RuntimeTaskBrief): Promise<void> => {
          await dependencies.sendText!(instanceId, renderRuntimeTaskBrief(task));
        }
      : undefined;
    adapter.attachHost(this);
  }

  async launch(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.assertManagedCodexRequest(request);
    return this.adapter.launch(request);
  }

  stop(instanceId: string): Promise<void> {
    return this.dependencies.stop(instanceId);
  }

  focus(instanceId: string): Promise<void> {
    return this.dependencies.focus(instanceId);
  }

  async restart(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.assertManagedCodexRequest(request);
    const resumedRequest = this.asResumeRequest(request, 'restart');
    await this.dependencies.stop(request.instance.instanceId);
    return this.adapter.launch(resumedRequest);
  }

  async resume(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
    this.assertManagedCodexRequest(request);
    return this.adapter.launch(this.asResumeRequest(request, 'resume'));
  }

  private asResumeRequest(
    request: RuntimeLaunchRequest,
    operation: 'restart' | 'resume',
  ): RuntimeLaunchRequest {
    const sessionId = request.sessionId ?? request.instance.sessionId;
    if (!sessionId?.trim()) {
      throw new Error('Codex ' + operation + ' requires a sessionId.');
    }
    return { ...request, sessionMode: 'resume', sessionId };
  }

  private assertManagedCodexRequest(request: RuntimeLaunchRequest): void {
    if (request.instance.runtime !== 'codex-cli') {
      throw new Error('CodexFleetRuntimeHost only manages Codex CLI requests.');
    }
    if (!request.instance.managedByFleet) {
      throw new Error('CodexFleetRuntimeHost cannot launch an external instance.');
    }
    if (!request.cwd.trim()) {
      throw new Error('CodexFleetRuntimeHost requires a workspace cwd.');
    }
  }
}
