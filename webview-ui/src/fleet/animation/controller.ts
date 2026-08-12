import type { FleetEvent, FleetEventType } from '../../../../core/src/fleetTelemetry.js';
import {
  type AnimationPerformanceInput,
  type AnimationPerformancePolicy,
  getAnimationPerformancePolicy,
} from './performance.js';

export type AnimationEvent = Pick<FleetEvent, 'eventType'> &
  Partial<Omit<FleetEvent, 'eventType'>> & {
    subagentId?: string;
  };

export type AnimationEffectKind =
  | 'task-finished-pulse'
  | 'tool-started-effect'
  | 'subagent-launch'
  | 'subagent-return'
  | 'provider-switched-pulse'
  | 'session-resumed-pulse';

export interface AnimationTarget {
  agentId?: number;
  instanceId?: string;
}

export interface AnimationEffect {
  id: string;
  kind: AnimationEffectKind;
  target: AnimationTarget;
  startedAt: number;
  expiresAt: number;
  progress: number;
  metadata?: { tool?: string; provider?: string };
}

export interface AnimationDrone {
  id: string;
  parent: AnimationTarget;
  startedAt: number;
  expiresAt: number;
  progress: number;
}

export interface AnimationSnapshot {
  effects: AnimationEffect[];
  drones: AnimationDrone[];
  policy: AnimationPerformancePolicy;
}

export interface AnimationControllerOptions {
  now?: () => number;
  durations?: Partial<Record<AnimationEffectKind | 'drone', number>>;
  performance?: AnimationPerformanceInput;
  maxEffects?: number;
}

const DEFAULT_DURATIONS: Record<AnimationEffectKind | 'drone', number> = {
  'task-finished-pulse': 900,
  'tool-started-effect': 450,
  'subagent-launch': 700,
  'subagent-return': 700,
  'provider-switched-pulse': 800,
  'session-resumed-pulse': 800,
  drone: 5000,
};

function durationFor(
  durations: Record<AnimationEffectKind | 'drone', number>,
  key: AnimationEffectKind | 'drone',
): number {
  return Math.max(1, durations[key]);
}

function targetOf(event: AnimationEvent): AnimationTarget {
  return { agentId: event.agentId, instanceId: event.instanceId };
}

function targetKey(target: AnimationTarget): string {
  return `${target.instanceId ?? ''}:${target.agentId ?? ''}`;
}

function progressAt(startedAt: number, expiresAt: number, now: number): number {
  if (now <= startedAt) return 0;
  if (now >= expiresAt) return 1;
  return (now - startedAt) / (expiresAt - startedAt);
}

export class VisualAnimationController {
  private readonly clock: () => number;
  private readonly durations: Record<AnimationEffectKind | 'drone', number>;
  private readonly maxEffects: number;
  private policy: AnimationPerformancePolicy;
  private sequence = 0;
  private readonly seenEvents = new Set<string>();
  private readonly effects = new Map<string, Omit<AnimationEffect, 'progress'>>();
  private readonly drones = new Map<string, Omit<AnimationDrone, 'progress'>>();

  constructor(options: AnimationControllerOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.durations = { ...DEFAULT_DURATIONS, ...options.durations };
    this.maxEffects = Math.max(1, Math.floor(options.maxEffects ?? 32));
    this.policy = getAnimationPerformancePolicy(options.performance);
  }

  setPerformance(input: AnimationPerformanceInput): AnimationPerformancePolicy {
    this.policy = getAnimationPerformancePolicy(input);
    return this.policy;
  }

  consume(event: AnimationEvent, now = this.clock()): AnimationSnapshot {
    if (event.eventId && this.seenEvents.has(event.eventId)) return this.snapshot(now);
    if (event.eventId) this.seenEvents.add(event.eventId);

    const target = targetOf(event);
    switch (event.eventType) {
      case 'task_finished':
        this.addEffect('task-finished-pulse', target, now);
        break;
      case 'tool_started':
        this.addEffect('tool-started-effect', target, now, { tool: event.currentTool });
        break;
      case 'subagent_started': {
        const id = event.subagentId ?? event.eventId ?? `drone-${++this.sequence}`;
        this.drones.set(id, {
          id,
          parent: target,
          startedAt: now,
          expiresAt: now + durationFor(this.durations, 'drone'),
        });
        this.addEffect('subagent-launch', target, now);
        break;
      }
      case 'subagent_finished': {
        const id = event.subagentId;
        if (id) this.drones.delete(id);
        this.addEffect('subagent-return', target, now);
        break;
      }
      case 'provider_switched':
        this.addEffect('provider-switched-pulse', target, now, {
          provider: event.providerDisplayName,
        });
        break;
      case 'session_resumed':
        this.addEffect('session-resumed-pulse', target, now);
        break;
      default:
        break;
    }
    return this.snapshot(now);
  }

  snapshot(now = this.clock()): AnimationSnapshot {
    for (const [id, effect] of this.effects) {
      if (effect.expiresAt <= now) this.effects.delete(id);
    }
    for (const [id, drone] of this.drones) {
      if (drone.expiresAt <= now) this.drones.delete(id);
    }
    return {
      policy: this.policy,
      effects: [...this.effects.values()].map((effect) => ({
        ...effect,
        progress: this.policy.animate ? progressAt(effect.startedAt, effect.expiresAt, now) : 0,
      })),
      drones: [...this.drones.values()].map((drone) => ({
        ...drone,
        progress: this.policy.animate ? progressAt(drone.startedAt, drone.expiresAt, now) : 0,
      })),
    };
  }

  clear(): void {
    this.effects.clear();
    this.drones.clear();
    this.seenEvents.clear();
  }

  private addEffect(
    kind: AnimationEffectKind,
    target: AnimationTarget,
    now: number,
    metadata?: AnimationEffect['metadata'],
  ): void {
    const id = `${kind}:${targetKey(target)}:${++this.sequence}`;
    const duration = durationFor(this.durations, kind);
    this.effects.set(id, {
      id,
      kind,
      target,
      startedAt: now,
      expiresAt: now + duration,
      metadata,
    });
    while (this.effects.size > this.maxEffects) {
      const oldest = this.effects.keys().next().value;
      if (oldest === undefined) break;
      this.effects.delete(oldest);
    }
  }
}

export type { AnimationPerformanceInput, AnimationPerformancePolicy } from './performance.js';
export type { FleetEventType };
