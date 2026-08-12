import { describe, expect, test } from 'vitest';

import {
  type AnimationPerformanceInput,
  getAnimationPerformancePolicy,
} from '../src/fleet/animation/performance.js';

describe('animation performance policy', () => {
  test.each([
    [{}, { mode: 'foreground', frameIntervalMs: 33, animate: true, scheduleFrames: true }],
    [{ backgrounded: true }, { mode: 'background', frameIntervalMs: 250, scheduleFrames: true }],
    [{ visibility: 'hidden' }, { mode: 'hidden', frameIntervalMs: 1000, scheduleFrames: false }],
    [
      { prefersReducedMotion: true },
      { mode: 'reduced-motion', animate: false, scheduleFrames: false },
    ],
  ] as Array<[AnimationPerformanceInput, Record<string, unknown>]>)(
    'returns %o',
    (input, expected) => {
      expect(getAnimationPerformancePolicy(input)).toMatchObject(expected);
    },
  );

  test('reduced motion suppresses progress animation while preserving event lifetime', () => {
    const policy = getAnimationPerformancePolicy({ prefersReducedMotion: true });
    expect(policy.animate).toBe(false);
    expect(policy.scheduleFrames).toBe(false);
  });
});
