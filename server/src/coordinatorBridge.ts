import type {
  FleetControlApi,
  FleetControlPolicy,
  FleetControlRequest,
  FleetControlResponse,
  FleetLaunchTemplate,
  FleetMetricsSnapshot,
  FleetMissionInput,
  FleetWorkItemInput,
  FleetWorkItemResultInput,
} from '../../core/src/controlContracts.js';
import type { FleetControlMode, FleetInstance } from '../../core/src/runtimeContracts.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The input accepted by the Coordinator boundary for one worker.
 *
 * `requestedBy` and the policy mode are owned by the bridge, not by an
 * individual worker. This prevents one worker in a batch from silently
 * switching the authorization mode or coordinator identity.
 */
export type CoordinatorLaunchPlan = Omit<FleetLaunchTemplate, 'requestedBy' | 'policy'> & {
  policy?: Partial<FleetControlPolicy>;
};

export type CoordinatorWorkItemPlan = Omit<FleetWorkItemInput, 'missionId'>;

export interface CoordinatorWorkerPlan {
  instanceId: string;
  launch: CoordinatorLaunchPlan;
  workItem?: CoordinatorWorkItemPlan;
}

export interface CoordinatorBridgePlan {
  requestedBy: string;
  mode?: FleetControlMode;
  policy?: Omit<FleetControlPolicy, 'mode'>;
  mission?: FleetMissionInput;
  workers: CoordinatorWorkerPlan[];
}

export interface CoordinatorWorkerExecution {
  instanceId: string;
  workItemId?: string;
  workItem?: FleetControlResponse;
  launch: FleetControlResponse;
  assignment?: FleetControlResponse;
  delivery?: FleetControlResponse;
}

export interface CoordinatorBridgeResult {
  mission?: FleetControlResponse;
  workers: CoordinatorWorkerExecution[];
}

export interface CoordinatorBridgeStatus {
  instances: FleetInstance[];
  metrics: FleetMetricsSnapshot;
}

export interface CoordinatorBridgeOptions {
  mode?: FleetControlMode;
  policy?: Omit<FleetControlPolicy, 'mode'>;
  now?: () => number;
  requestIdPrefix?: string;
}

export type CoordinatorBridgeControl = Pick<
  FleetControlApi,
  'submit' | 'listInstances' | 'getMetrics'
>;

/**
 * Thin orchestration boundary for a primary Coordinator.
 *
 * This class intentionally does not spawn processes or talk to VS Code. The
 * injected FleetControlApi remains the only side-effect boundary, which means
 * the same bridge works over the local HTTP client from Codex and in-process
 * with FleetControlService tests.
 */
export class CoordinatorBridge {
  private readonly control: CoordinatorBridgeControl;
  private readonly requestedBy: string;
  private readonly mode: FleetControlMode;
  private readonly policy: Omit<FleetControlPolicy, 'mode'>;
  private readonly now: () => number;
  private readonly requestIdPrefix: string;

  constructor(
    control: CoordinatorBridgeControl,
    requestedBy: string,
    options: CoordinatorBridgeOptions = {},
  ) {
    assertSafeId(requestedBy, 'requestedBy');
    this.control = control;
    this.requestedBy = requestedBy;
    this.mode = options.mode ?? 'approve';
    this.policy = { ...options.policy };
    this.now = options.now ?? (() => Date.now());
    this.requestIdPrefix = sanitizeId(options.requestIdPrefix ?? `coord-${requestedBy}`);
  }

  /**
   * Run a bounded multi-worker plan. Workers are launched sequentially so the
   * Control API can enforce policy and each result can be correlated before
   * the next side effect starts. Terminals are still independent because each
   * worker carries its own stable instanceId and launch template.
   */
  async execute(plan: CoordinatorBridgePlan): Promise<CoordinatorBridgeResult> {
    if (plan.requestedBy !== this.requestedBy) {
      throw new Error('CoordinatorBridge plan requestedBy must match the bridge owner.');
    }
    if (plan.mode !== undefined && plan.mode !== this.mode) {
      throw new Error('CoordinatorBridge plan mode must match the bridge policy.');
    }
    if (plan.workers.length === 0) {
      throw new Error('CoordinatorBridge requires at least one worker.');
    }
    if (plan.workers.length > 32) {
      throw new Error('CoordinatorBridge accepts at most 32 workers per plan.');
    }

    const missionResponse = plan.mission
      ? await this.submit(
          {
            action: 'create_mission',
            missionId: plan.mission.missionId,
            mission: plan.mission,
          },
          `mission-${plan.mission.missionId}`,
        )
      : undefined;

    if (missionResponse && missionResponse.decision !== 'accepted') {
      return { mission: missionResponse, workers: [] };
    }

    const workerIds = new Set<string>();
    const workers: CoordinatorWorkerExecution[] = [];
    for (const worker of plan.workers) {
      assertSafeId(worker.instanceId, 'worker.instanceId');
      if (workerIds.has(worker.instanceId)) {
        throw new Error(`CoordinatorBridge contains duplicate instanceId: ${worker.instanceId}.`);
      }
      workerIds.add(worker.instanceId);
      if (worker.launch.terminalPolicy === 'reuse') {
        throw new Error(
          `Worker ${worker.instanceId} must use a new terminal. Use resume/focus for an existing instance.`,
        );
      }

      const workItemId = worker.workItem?.workItemId;
      if (worker.workItem && !plan.mission) {
        throw new Error(`Worker ${worker.instanceId} has a WorkItem but no Mission.`);
      }
      if (worker.workItem?.repo) {
        // The ControlService owns conflict checks. This local check only makes
        // the request correlation explicit and avoids accidental mismatches.
        if (worker.workItem.repo !== worker.launch.repo) {
          throw new Error(`Worker ${worker.instanceId} WorkItem repo must match launch repo.`);
        }
      }

      const workItemResponse = worker.workItem
        ? await this.submit(
            {
              action: 'create_work_item',
              missionId: plan.mission!.missionId,
              workItemId,
              workItem: { ...worker.workItem, missionId: plan.mission!.missionId },
            },
            `work-item-${workItemId}`,
          )
        : undefined;

      const execution: CoordinatorWorkerExecution = {
        instanceId: worker.instanceId,
        workItemId,
        ...(workItemResponse ? { workItem: workItemResponse } : {}),
        launch: {
          requestId: this.requestId('launch', worker.instanceId),
          decision: 'unavailable',
          reason: 'Launch was not attempted.',
        },
      };
      workers.push(execution);

      if (workItemResponse && workItemResponse.decision !== 'accepted') continue;

      const launchResponse = await this.submit(
        {
          action: 'launch_instance',
          mode: this.mode,
          requestedBy: this.requestedBy,
          missionId: plan.mission?.missionId,
          workItemId,
          instanceId: worker.instanceId,
          launch: {
            ...worker.launch,
            launchSource: worker.launch.launchSource ?? 'coordinator',
            requestedBy: this.requestedBy,
            policy: {
              ...this.policy,
              ...worker.launch.policy,
              mode: this.mode,
            },
          },
        },
        `launch-${worker.instanceId}`,
      );
      execution.launch = launchResponse;
      if (launchResponse.decision !== 'accepted' || !workItemId || !plan.mission) continue;

      const assignment = await this.submit(
        {
          action: 'assign_work_item',
          mode: this.mode,
          requestedBy: this.requestedBy,
          missionId: plan.mission.missionId,
          workItemId,
          instanceId: worker.instanceId,
        },
        `assign-${workItemId}`,
      );
      execution.assignment = assignment;
      if (assignment.decision !== 'accepted') continue;

      execution.delivery = await this.submit(
        {
          action: 'deliver_work_item',
          mode: this.mode,
          requestedBy: this.requestedBy,
          missionId: plan.mission.missionId,
          workItemId,
          instanceId: worker.instanceId,
        },
        `deliver-${workItemId}`,
      );
    }

    return { ...(missionResponse ? { mission: missionResponse } : {}), workers };
  }

  async status(): Promise<CoordinatorBridgeStatus> {
    const [instances, metrics] = await Promise.all([
      this.control.listInstances(),
      this.control.getMetrics(),
    ]);
    return { instances, metrics };
  }

  async focus(instanceId: string): Promise<FleetControlResponse> {
    return this.instanceAction('focus_instance', instanceId);
  }

  async stop(instanceId: string): Promise<FleetControlResponse> {
    return this.instanceAction('stop_instance', instanceId);
  }

  async restart(instanceId: string): Promise<FleetControlResponse> {
    return this.instanceAction('restart_instance', instanceId);
  }

  async resume(instanceId: string): Promise<FleetControlResponse> {
    return this.instanceAction('resume_instance', instanceId);
  }

  async collectResult(result: FleetWorkItemResultInput): Promise<FleetControlResponse> {
    return this.submit(
      {
        action: 'collect_result',
        workItemId: result.workItemId,
        instanceId: result.instanceId,
        result,
      },
      `result-${result.workItemId ?? result.instanceId ?? 'unknown'}`,
    );
  }

  private async instanceAction(
    action: 'focus_instance' | 'stop_instance' | 'restart_instance' | 'resume_instance',
    instanceId: string,
  ): Promise<FleetControlResponse> {
    assertSafeId(instanceId, 'instanceId');
    return this.submit({ action, mode: this.mode, instanceId }, `${action}-${instanceId}`);
  }

  private async submit(
    input: Pick<FleetControlRequest, 'action'> & Partial<FleetControlRequest>,
    key: string,
  ): Promise<FleetControlResponse> {
    const request: FleetControlRequest = {
      ...input,
      requestId: this.requestId(input.action, key),
      mode: input.mode ?? this.mode,
      requestedBy: input.requestedBy ?? this.requestedBy,
      createdAt: this.now(),
    };
    return this.control.submit(request);
  }

  private requestId(action: string, key: string): string {
    return sanitizeId(`${this.requestIdPrefix}-${action}-${key}`);
  }
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field} must be a safe non-empty identifier.`);
}

function sanitizeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const bounded = normalized.slice(0, 128);
  return bounded || 'coordinator';
}
