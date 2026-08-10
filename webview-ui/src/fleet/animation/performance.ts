export type AnimationVisibility = 'visible' | 'hidden';

export interface AnimationPerformanceInput {
  prefersReducedMotion?: boolean;
  visibility?: AnimationVisibility;
  backgrounded?: boolean;
}

export interface AnimationPerformancePolicy {
  animate: boolean;
  scheduleFrames: boolean;
  frameIntervalMs: number;
  mode: 'foreground' | 'background' | 'hidden' | 'reduced-motion';
}

/** Pure scheduling policy. The controller never owns a requestAnimationFrame loop. */
export function getAnimationPerformancePolicy(
  input: AnimationPerformanceInput = {},
): AnimationPerformancePolicy {
  if (input.prefersReducedMotion) {
    return {
      animate: false,
      scheduleFrames: false,
      frameIntervalMs: 0,
      mode: 'reduced-motion',
    };
  }
  if (input.visibility === 'hidden') {
    return { animate: true, scheduleFrames: false, frameIntervalMs: 1000, mode: 'hidden' };
  }
  if (input.backgrounded) {
    return { animate: true, scheduleFrames: true, frameIntervalMs: 250, mode: 'background' };
  }
  return { animate: true, scheduleFrames: true, frameIntervalMs: 33, mode: 'foreground' };
}
