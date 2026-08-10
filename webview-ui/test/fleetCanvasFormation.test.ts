import { describe, expect, test } from 'vitest';

import {
  assignFormationSlots,
  computeFleetFormation,
  type FormationVessel,
  groupVesselsByRepo,
  groupVesselsByRole,
  hitTestFleetFormation,
  pointInFormationHitbox,
} from '../src/fleet/canvas/index.js';

const vessel = (id: number, overrides: Partial<FormationVessel> = {}): FormationVessel => ({
  id,
  repo: 'agent-fleet',
  role: 'worker',
  status: 'idle',
  ...overrides,
});

describe('fleet canvas formation pure functions', () => {
  test('keeps existing slots when roster order changes or a new vessel joins', () => {
    const initial = assignFormationSlots([
      vessel(1, { role: 'coordinator' }),
      vessel(2),
      vessel(3),
    ]);
    const updated = assignFormationSlots(
      [vessel(3), vessel(4), vessel(1, { role: 'coordinator' }), vessel(2)],
      initial.state,
    );

    expect(updated.assignments['agent-fleet::1']).toBe(initial.assignments['agent-fleet::1']);
    expect(updated.assignments['agent-fleet::2']).toBe(initial.assignments['agent-fleet::2']);
    expect(updated.assignments['agent-fleet::3']).toBe(initial.assignments['agent-fleet::3']);
    expect(updated.assignments['agent-fleet::4']).toBe(3);
  });

  test('is deterministic on first allocation and honors an explicit preferred slot', () => {
    const first = assignFormationSlots([
      vessel(4),
      vessel(1, { role: 'reviewer' }),
      vessel(2, { preferredSlot: 7 }),
    ]);
    const reordered = assignFormationSlots([
      vessel(2, { preferredSlot: 7 }),
      vessel(4),
      vessel(1, { role: 'reviewer' }),
    ]);

    expect(first.assignments).toEqual(reordered.assignments);
    expect(first.assignments['agent-fleet::2']).toBe(7);
  });

  test('groups by repo and role with stable member ordering', () => {
    const vessels = [
      vessel(3, { repo: 'repo-b', role: 'reviewer' }),
      vessel(2, { repo: 'repo-a', role: 'worker' }),
      vessel(1, { repo: 'repo-a', role: 'coordinator' }),
    ];

    expect(groupVesselsByRepo(vessels).map((group) => [group.key, group.vesselKeys])).toEqual([
      ['repo-a', ['repo-a::1', 'repo-a::2']],
      ['repo-b', ['repo-b::3']],
    ]);
    expect(groupVesselsByRole(vessels).map((group) => group.key)).toEqual([
      'coordinator',
      'reviewer',
      'worker',
    ]);
  });

  test('lays out twenty vessels in stable, bounded cells with useful hitboxes', () => {
    const vessels = Array.from({ length: 20 }, (_, index) =>
      vessel(index + 1, {
        repo: index < 10 ? 'repo-a' : 'repo-b',
        role: index === 0 ? 'coordinator' : index % 4 === 0 ? 'reviewer' : 'worker',
      }),
    );
    const layout = computeFleetFormation(vessels, { width: 1000, height: 640 });

    expect(layout.nodes).toHaveLength(20);
    expect(new Set(layout.nodes.map((node) => node.slot)).size).toBe(20);
    expect(layout.rows).toBeGreaterThanOrEqual(4);
    for (const node of layout.nodes) {
      expect(node.position.x).toBeGreaterThan(0);
      expect(node.position.x).toBeLessThan(1000);
      expect(node.position.y).toBeGreaterThan(0);
      expect(node.position.y).toBeLessThan(640);
      expect(pointInFormationHitbox(node.position, node.hitbox)).toBe(true);
    }
    expect(layout.repoGroups).toHaveLength(2);
    expect(layout.roleGroups.length).toBeGreaterThan(1);
  });

  test('hit tests return the vessel node, not a visual index', () => {
    const layout = computeFleetFormation([vessel(42)], { width: 400, height: 240 });
    const node = layout.nodes[0];
    expect(node).toBeDefined();
    expect(hitTestFleetFormation(node?.position ?? { x: 0, y: 0 }, layout)?.vessel.id).toBe(42);
    expect(hitTestFleetFormation({ x: 399, y: 239 }, layout)).toBeNull();
  });
});
