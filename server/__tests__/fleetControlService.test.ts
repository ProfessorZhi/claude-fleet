import { describe, expect, it } from 'vitest';

import type { FleetControlRequest, FleetLaunchTemplate } from '../../core/src/controlContracts.js';
import type { RuntimeLaunchRequest, WorkItem } from '../../core/src/runtimeContracts.js';
import {
  FleetControlService,
  type FleetControlServiceOptions,
} from '../src/fleetControlService.js';
import { FleetLedgerStore } from '../src/fleetLedgerStore.js';
import { InMemoryFleetSnapshotPersistence } from '../src/persistence/fleetSnapshotPersistence.js';
import {
  CodexFleetRuntimeHost,
  type CodexFleetRuntimeHostDependencies,
} from '../src/providers/codex/codexFleetRuntimeHost.js';
import {
  type CodexFileSystem,
  CodexRuntimeAdapter,
} from '../src/providers/codex/codexRuntimeAdapter.js';

const fileSystem: CodexFileSystem = {
  existsSync: (candidate) => candidate === 'C:\\codex\\codex.cmd',
};

function launch(overrides: Partial<FleetLaunchTemplate> = {}): FleetLaunchTemplate {
  return {
    runtime: 'codex-cli',
    role: 'worker',
    repo: 'F:/repo',
    cwd: 'F:/repo',
    requestedBy: 'codex-primary',
    policy: { mode: 'suggest' },
    ...overrides,
  };
}

function request(overrides: Partial<FleetControlRequest> = {}): FleetControlRequest {
  return {
    requestId: 'request-1',
    action: 'launch_instance',
    mode: 'suggest',
    requestedBy: 'codex-primary',
    launch: launch(),
    createdAt: 1,
    ...overrides,
  };
}

function makeService(
  options: {
    onLaunch?: (
      request: RuntimeLaunchRequest,
    ) => Promise<{ instanceId: string; sessionId: string; startedAt: number }>;
    calls?: string[];
    instances?: FleetControlServiceOptions['instances'];
  } = {},
): FleetControlService {
  const calls = options.calls ?? [];
  const adapter = new CodexRuntimeAdapter({
    platform: 'win32',
    pathEnv: 'C:\\codex',
    fs: fileSystem,
    verify: async () => 'codex-test',
    launch: async (launchRequest) => {
      calls.push('launch');
      return options.onLaunch
        ? options.onLaunch(launchRequest)
        : { instanceId: launchRequest.instance.instanceId, sessionId: 'session-1', startedAt: 2 };
    },
  });
  const dependencies: CodexFleetRuntimeHostDependencies = {
    stop: async (instanceId) => {
      calls.push('stop:' + instanceId);
    },
    focus: async (instanceId) => {
      calls.push('focus:' + instanceId);
    },
  };
  const host = new CodexFleetRuntimeHost(adapter, dependencies);
  return new FleetControlService({
    now: () => 10,
    registrations: [{ adapter, host }],
    instances: options.instances,
  });
}

describe('FleetControlService', () => {
  it('creates auditable missions and work items through the control boundary', async () => {
    const service = makeService();
    const mission = await service.submit({
      requestId: 'request-mission',
      action: 'create_mission',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      createdAt: 1,
      mission: {
        missionId: 'mission-1',
        title: 'Telemetry',
        objective: 'Normalize runtime signals',
        policyMode: 'suggest',
        repoScope: ['F:/repo'],
      },
    });
    const workItem = await service.submit({
      requestId: 'request-work',
      action: 'create_work_item',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: 'mission-1',
      createdAt: 2,
      workItem: {
        workItemId: 'work-1',
        missionId: 'mission-1',
        title: 'Normalize events',
        objective: 'Create one FleetEvent boundary',
        acceptanceCriteria: ['tests pass'],
      },
    });

    expect(mission.decision).toBe('accepted');
    expect(workItem.workItem?.status).toBe('queued');
    expect(service.ledger.getMission('mission-1')?.coordinatorId).toBe('codex-primary');
    expect(service.ledger.getWorkItem('work-1')?.missionId).toBe('mission-1');
  });

  it('hydrates missions and work items from an injected ledger snapshot', async () => {
    const persistence = new InMemoryFleetSnapshotPersistence();
    const persistentService = new FleetControlService({
      ledger: new FleetLedgerStore({ persistence }),
      now: () => 10,
    });

    await persistentService.submit({
      requestId: 'persist-mission',
      action: 'create_mission',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      createdAt: 1,
      mission: {
        missionId: 'mission-persisted',
        title: 'Persisted mission',
        objective: 'Survive a restart',
        policyMode: 'suggest',
      },
    });
    await persistentService.submit({
      requestId: 'persist-work',
      action: 'create_work_item',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: 'mission-persisted',
      createdAt: 2,
      workItem: {
        workItemId: 'work-persisted',
        missionId: 'mission-persisted',
        title: 'Persisted work',
        objective: 'Restore metadata',
        acceptanceCriteria: ['restored'],
      },
    });

    const restored = new FleetControlService({
      ledger: new FleetLedgerStore({ persistence }),
      now: () => 10,
    });
    expect(await restored.getMission('mission-persisted')).toMatchObject({
      title: 'Persisted mission',
    });
    expect(await restored.getWorkItem('work-persisted')).toMatchObject({
      title: 'Persisted work',
    });
  });

  it('exposes worktree lifecycle and rejects a conflicting WorkItem path', async () => {
    const service = makeService();
    await service.createWorktree({
      worktreeId: 'wt-existing',
      repo: 'F:/repo',
      worktreePath: 'F:/repo/.worktrees/shared',
      branch: 'fleet/shared',
      workItemId: 'work-existing',
      createdAt: 1,
    });

    await service.submit({
      requestId: 'worktree-mission',
      action: 'create_mission',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      createdAt: 2,
      mission: {
        missionId: 'mission-worktree',
        title: 'Worktree',
        objective: 'Keep workers isolated',
        policyMode: 'suggest',
      },
    });
    const response = await service.submit({
      requestId: 'worktree-conflict',
      action: 'create_work_item',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: 'mission-worktree',
      createdAt: 3,
      workItem: {
        workItemId: 'work-conflict',
        missionId: 'mission-worktree',
        title: 'Conflicting work',
        objective: 'Must not share a worktree',
        acceptanceCriteria: ['rejected'],
        repo: 'F:/repo',
        worktree: 'F:/repo/.worktrees/shared',
      },
    });

    await expect(
      service.checkWorktreeConflict({
        repo: 'F:/repo',
        worktreePath: 'F:/repo/.worktrees/shared',
        workItemId: 'work-conflict',
      }),
    ).resolves.toMatchObject({ conflict: true });
    expect(response).toMatchObject({ decision: 'rejected' });
  });

  it('returns and records a strategy recommendation without launching a runtime', async () => {
    const calls: string[] = [];
    const service = makeService({
      calls,
      instances: [
        {
          instanceId: 'claude-1',
          runtime: 'claude-code',
          role: 'worker',
          managedByFleet: true,
          repo: 'F:/repo',
          worktree: 'F:/repo/.worktrees/claude-1',
          status: 'idle',
          createdAt: 1,
        },
      ],
    });
    await service.submit({
      requestId: 'recommend-mission',
      action: 'create_mission',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      createdAt: 1,
      mission: {
        missionId: 'mission-recommend',
        title: 'Strategy',
        objective: 'Recommend the next worker',
        policyMode: 'suggest',
      },
    });
    const workItem: WorkItem = {
      workItemId: 'work-recommend',
      missionId: 'mission-recommend',
      title: 'Choose worker',
      objective: 'Select an eligible existing instance.',
      acceptanceCriteria: ['recommendation is recorded'],
      status: 'queued',
      repo: 'F:/repo',
      createdAt: 1,
    };
    await service.submit({
      requestId: 'recommend-work',
      action: 'create_work_item',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: workItem.missionId,
      createdAt: 2,
      workItem,
    });

    const response = await service.submit({
      requestId: 'recommend-request',
      action: 'recommend_assignment',
      mode: 'suggest',
      requestedBy: 'codex-primary',
      missionId: workItem.missionId,
      workItemId: workItem.workItemId,
      createdAt: 3,
      strategy: {
        now: 3,
        workItem,
        policy: { mode: 'suggest' },
        candidates: [],
      },
    });

    expect(response.decision).toBe('accepted');
    expect(response.recommendation).toMatchObject({
      action: 'assign_existing',
      selectedInstanceId: 'claude-1',
    });
    expect(service.ledger.listAssignments(workItem.workItemId)).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('returns approval_required without launching in suggest mode', async () => {
    const calls: string[] = [];
    const service = makeService({ calls });

    const response = await service.submit(request());

    expect(response.decision).toBe('approval_required');
    expect(calls).toEqual([]);
    expect(service.ledger.listControlDecisions('request-1')[0]).toMatchObject({
      decision: 'approval_required',
      requestedBy: 'codex-primary',
    });
  });

  it('launches through the registered adapter and host in approve mode', async () => {
    const calls: string[] = [];
    const service = makeService({ calls });

    const response = await service.submit(
      request({
        requestId: 'request-approve',
        mode: 'approve',
        instanceId: 'codex-1',
        missionId: 'mission-1',
        workItemId: 'work-1',
        launch: launch({
          policy: { mode: 'approve' },
          sessionMode: 'new',
        }),
      }),
    );

    expect(response.decision).toBe('accepted');
    expect(response.instance).toMatchObject({
      instanceId: 'codex-1',
      runtime: 'codex-cli',
      managedByFleet: true,
      sessionId: 'session-1',
      status: 'starting',
    });
    expect(calls).toEqual(['launch']);
    expect(service.ledger.listLaunches('codex-1')[0].result).toBe('started');
    expect(service.ledger.getSession('session-1')?.status).toBe('starting');
  });

  it('HOST_PROJECTION_DURING_LAUNCH_IS_NOT_OVERWRITTEN', async () => {
    let service!: FleetControlService;
    service = makeService({
      onLaunch: async (launchRequest) => {
        service.observeRuntimeInstance({
          ...launchRequest.instance,
          sessionId: 'native-session',
          status: 'idle',
          bootstrap: { state: 'ready', observedAt: 11 },
        });
        return {
          instanceId: launchRequest.instance.instanceId,
          sessionId: 'native-session',
          startedAt: 12,
        };
      },
    });

    const response = await service.submit(
      request({
        requestId: 'request-runtime-projection',
        instanceId: 'codex-runtime-projection',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve' } }),
      }),
    );

    expect(response.instance).toMatchObject({
      status: 'idle',
      bootstrap: { state: 'ready' },
      sessionId: 'native-session',
    });
    await expect(service.getInstance('codex-runtime-projection')).resolves.toMatchObject({
      status: 'idle',
      bootstrap: { state: 'ready' },
    });
  });

  it('preserves needs_user_interaction projected by the host during launch', async () => {
    let service!: FleetControlService;
    service = makeService({
      onLaunch: async (launchRequest) => {
        service.observeRuntimeInstance({
          ...launchRequest.instance,
          status: 'waiting',
          bootstrap: {
            state: 'needs_user_interaction',
            reason: 'startup_interaction',
            observedAt: 11,
          },
        });
        return {
          instanceId: launchRequest.instance.instanceId,
          startedAt: 12,
          sessionId: 'waiting-session',
        };
      },
    });

    const response = await service.submit(
      request({
        requestId: 'request-startup-interaction',
        instanceId: 'codex-startup-interaction',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve' } }),
      }),
    );

    expect(response.instance).toMatchObject({
      status: 'waiting',
      bootstrap: { state: 'needs_user_interaction' },
    });
  });

  it('STOP_DURING_LAUNCH_CANNOT_BE_OVERWRITTEN', async () => {
    let releaseLaunch!: () => void;
    let markLaunchEntered!: () => void;
    const launchEntered = new Promise<void>((resolve) => {
      markLaunchEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let service!: FleetControlService;
    service = makeService({
      onLaunch: async (launchRequest) => {
        service.observeRuntimeInstance({
          ...launchRequest.instance,
          bootstrap: { state: 'starting', observedAt: 11 },
        });
        markLaunchEntered();
        await release;
        return {
          instanceId: launchRequest.instance.instanceId,
          startedAt: 12,
          sessionId: 'late-session',
        };
      },
    });

    const launchPromise = service.submit(
      request({
        requestId: 'request-stop-during-launch',
        instanceId: 'codex-stop-during-launch',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve' } }),
      }),
    );
    await launchEntered;

    const stop = await service.submit({
      requestId: 'request-stop-before-launch-resolves',
      action: 'stop_instance',
      mode: 'approve',
      requestedBy: 'codex-primary',
      instanceId: 'codex-stop-during-launch',
      createdAt: 3,
    });
    expect(stop.decision).toBe('accepted');
    expect(stop.instance).toMatchObject({ status: 'stopped', bootstrap: { state: 'stopped' } });

    releaseLaunch();
    const launchResponse = await launchPromise;
    expect(launchResponse.instance).toMatchObject({
      status: 'stopped',
      bootstrap: { state: 'stopped' },
    });
    await expect(service.getInstance('codex-stop-during-launch')).resolves.toMatchObject({
      status: 'stopped',
      bootstrap: { state: 'stopped' },
    });
  });

  it('markInstanceStopped converges bootstrap and status', async () => {
    const service = makeService({
      instances: [
        {
          instanceId: 'codex-removed',
          runtime: 'codex-cli',
          role: 'worker',
          managedByFleet: true,
          status: 'idle',
          bootstrap: { state: 'ready', observedAt: 1 },
          createdAt: 1,
        },
      ],
    });

    service.markInstanceStopped('codex-removed', 20);

    await expect(service.getInstance('codex-removed')).resolves.toMatchObject({
      status: 'stopped',
      bootstrap: { state: 'stopped', observedAt: 20 },
    });
  });

  it('is idempotent by requestId', async () => {
    const calls: string[] = [];
    const service = makeService({ calls });
    const approved = request({
      requestId: 'request-idempotent',
      mode: 'approve',
      launch: launch({ policy: { mode: 'approve' } }),
    });

    const first = await service.submit(approved);
    const second = await service.submit(approved);

    expect(second).toEqual(first);
    expect(calls).toEqual(['launch']);
    expect(service.ledger.listControlDecisions('request-idempotent')).toHaveLength(1);
  });

  it('enforces concurrent policy before invoking a runtime', async () => {
    const calls: string[] = [];
    const service = makeService({
      calls,
      instances: [
        {
          instanceId: 'existing',
          runtime: 'codex-cli',
          role: 'worker',
          managedByFleet: true,
          status: 'working',
          createdAt: 1,
        },
      ],
    });

    const response = await service.submit(
      request({
        requestId: 'request-limit',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve', maxConcurrentInstances: 1 } }),
      }),
    );

    expect(response).toMatchObject({ decision: 'rejected' });
    expect(response.reason).toContain('concurrent');
    expect(calls).toEqual([]);
  });

  it('routes focus and stop through the host and updates state', async () => {
    const calls: string[] = [];
    const service = makeService({ calls });
    await service.submit(
      request({
        requestId: 'request-start',
        instanceId: 'codex-1',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve' } }),
      }),
    );

    const focus = await service.submit({
      requestId: 'request-focus',
      action: 'focus_instance',
      mode: 'approve',
      requestedBy: 'codex-primary',
      instanceId: 'codex-1',
      createdAt: 3,
    });
    const stop = await service.submit({
      requestId: 'request-stop',
      action: 'stop_instance',
      mode: 'approve',
      requestedBy: 'codex-primary',
      instanceId: 'codex-1',
      createdAt: 4,
    });

    expect(focus.decision).toBe('accepted');
    expect(stop.instance?.status).toBe('stopped');
    expect(calls).toEqual(['launch', 'focus:codex-1', 'stop:codex-1']);
  });

  it('redacts launch failures before recording them', async () => {
    const service = makeService({
      onLaunch: async () => {
        throw new Error('authorization=Bearer very-secret-value');
      },
    });

    const response = await service.submit(
      request({
        requestId: 'request-failure',
        mode: 'approve',
        launch: launch({ policy: { mode: 'approve' } }),
      }),
    );

    expect(response.reason).not.toContain('very-secret-value');
    expect(service.ledger.listLaunches()[0].error?.message).not.toContain('very-secret-value');
  });
});
