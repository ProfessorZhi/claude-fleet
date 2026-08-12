import { describe, expect, test } from 'vitest';

import { roleLabel, statusLabel, vesselLabel } from '../src/fleet/localization.js';

describe('Fleet Command display localization', () => {
  test('translates stable status and role labels without changing internal keys', () => {
    expect(statusLabel('Working')).toBe('工作中');
    expect(statusLabel('Waiting')).toBe('等待中');
    expect(roleLabel('worker')).toBe('工作 Agent');
    expect(vesselLabel('coordinator')).toBe('旗舰');
    expect(statusLabel('custom-runtime-state')).toBe('custom-runtime-state');
  });
});
