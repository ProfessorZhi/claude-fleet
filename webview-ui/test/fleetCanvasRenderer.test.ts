import { describe, expect, test } from 'vitest';

import {
  createFleetCanvasRenderer,
  drawFleetFormation,
  type FleetCanvasContext,
  type FormationVessel,
} from '../src/fleet/canvas/index.js';

function recordingContext() {
  const calls: string[] = [];
  const context: FleetCanvasContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    setLineDash: () => calls.push('setLineDash'),
  };
  return { context, calls };
}

const vessels: FormationVessel[] = [
  { id: 1, repo: 'repo-a', role: 'coordinator', status: 'working', runtime: 'codex-cli' },
  { id: 2, repo: 'repo-a', role: 'worker', status: 'waiting', runtime: 'claude-code' },
  { id: 3, repo: 'repo-b', role: 'reviewer', status: 'error' },
];

describe('fleet canvas renderer interface', () => {
  test('renders through a minimal context without requiring browser globals', () => {
    const { context, calls } = recordingContext();
    const renderer = createFleetCanvasRenderer();
    const layout = renderer.render(context, {
      vessels,
      width: 800,
      height: 480,
      selectedKey: 'repo-a::2',
      time: 1000,
    });

    expect(layout.nodes).toHaveLength(3);
    expect(calls[0]).toBe('clearRect');
    expect(calls).toContain('fillRect');
    expect(calls).toContain('strokeRect');
    expect(calls).toContain('arc');
    expect(calls).toContain('closePath');
  });

  test('keeps render and hit-test on the same returned layout', () => {
    const { context } = recordingContext();
    const renderer = createFleetCanvasRenderer({ columns: 4, hitRadius: 30 });
    const layout = renderer.render(context, { vessels, width: 640, height: 360 });
    const target = layout.nodes.find((node) => node.vessel.id === 3);

    expect(target).toBeDefined();
    expect(renderer.hitTest(target?.position ?? { x: 0, y: 0 }, layout)?.vessel.id).toBe(3);
  });

  test('drawFleetFormation can be used directly by a future Canvas component', () => {
    const { context, calls } = recordingContext();
    const renderer = createFleetCanvasRenderer();
    const layout = renderer.render(context, { vessels, width: 500, height: 320 });
    calls.length = 0;

    drawFleetFormation(context, layout, {}, null, 200);

    expect(calls[0]).toBe('clearRect');
    expect(calls.filter((call) => call === 'fillRect').length).toBeGreaterThan(1);
  });
});
