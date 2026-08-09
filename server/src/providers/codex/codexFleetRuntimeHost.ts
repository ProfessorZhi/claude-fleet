import type {
  FleetRuntimeHost,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../../../core/src/runtimeContracts.js';
import { CodexRuntimeAdapter } from './codexRuntimeAdapter.js';

export interface CodexFleetRuntimeHostDependencies {
  stop(instanceId: string): Promise<void>;
  focus(instanceId: string): Promise<void>;
}

/**
 * Management host for a Fleet-owned Codex CLI instance.
 *
 * The adapter still owns native Codex command construction. The host owns the
 * Fleet-side managed/external boundary and terminal lifecycle callbacks. A
 * real process/terminal bridge is injected; this class never shells out by
 * itself.
 */
export class CodexFleetRuntimeHost implements FleetRuntimeHost {
  readonly hostId = 'codex-cli-host';
  readonly hostType = 'codex-cli-host';

  constructor(
    private readonly adapter: CodexRuntimeAdapter,
    private readonly dependencies: CodexFleetRuntimeHostDependencies,
  ) {}

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
