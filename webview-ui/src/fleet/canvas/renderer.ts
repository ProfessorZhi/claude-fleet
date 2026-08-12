/* eslint-disable pixel-agents/no-inline-colors -- Canvas needs concrete colors in a pure renderer; CSS variables are not portable here. */
import { buildVesselVisualState } from '../visualState.js';
import { computeFleetFormation, hitTestFleetFormation } from './formation.js';
import type {
  FleetFormationLayout,
  FormationLayoutOptions,
  FormationPoint,
  FormationSlotState,
  FormationVessel,
} from './types.js';

/**
 * Deliberately small structural surface so the renderer can be tested with a
 * recording object. A real CanvasRenderingContext2D satisfies this interface,
 * but importing this module never touches document, window, or canvas globals.
 */
export interface FleetCanvasContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  setLineDash?(segments: number[]): void;
}

export interface FleetCanvasFrame {
  vessels: readonly FormationVessel[];
  width: number;
  height: number;
  previousSlots?: FormationSlotState | Readonly<Record<string, number>>;
  selectedKey?: string | null;
  time?: number;
}

export interface FleetCanvasRendererOptions extends FormationLayoutOptions {
  backgroundColor?: string;
  gridColor?: string;
  regionColor?: string;
  formationLineColor?: string;
}

export interface FleetCanvasRenderer {
  render(context: FleetCanvasContext, frame: FleetCanvasFrame): FleetFormationLayout;
  hitTest(
    point: FormationPoint,
    layout: FleetFormationLayout,
  ): ReturnType<typeof hitTestFleetFormation>;
}

const COLORS = {
  hull: '#172942',
  hullHighlight: '#42617d',
  cyan: '#67e8f9',
  violet: '#a78bfa',
  amber: '#fbbf24',
  red: '#fb7185',
  slate: '#94a3b8',
} as const;

function statusColor(status: string | undefined): string {
  switch (buildVesselVisualState({ role: 'worker', status }).beacon) {
    case 'waiting':
      return COLORS.amber;
    case 'error':
      return COLORS.red;
    case 'none':
    default:
      return COLORS.cyan;
  }
}

function drawFormationGrid(
  context: FleetCanvasContext,
  layout: FleetFormationLayout,
  options: FleetCanvasRendererOptions,
): void {
  context.strokeStyle = options.gridColor ?? 'rgba(103, 232, 249, 0.08)';
  context.lineWidth = 1;
  context.setLineDash?.([3, 9]);
  const cellWidth = layout.viewport.width / layout.columns;
  const cellHeight = layout.viewport.height / layout.rows;
  for (let column = 1; column < layout.columns; column += 1) {
    const x = Math.round(cellWidth * column) + 0.5;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, layout.viewport.height);
    context.stroke();
  }
  for (let row = 1; row < layout.rows; row += 1) {
    const y = Math.round(cellHeight * row) + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(layout.viewport.width, y);
    context.stroke();
  }
  context.setLineDash?.([]);
}

function drawRegionBounds(
  context: FleetCanvasContext,
  layout: FleetFormationLayout,
  options: FleetCanvasRendererOptions,
): void {
  context.strokeStyle = options.regionColor ?? 'rgba(167, 139, 250, 0.16)';
  context.lineWidth = 1;
  for (const group of layout.repoGroups) {
    if (!group.bounds) continue;
    context.strokeRect(group.bounds.x, group.bounds.y, group.bounds.width, group.bounds.height);
  }
}

function drawFormationLines(
  context: FleetCanvasContext,
  layout: FleetFormationLayout,
  options: FleetCanvasRendererOptions,
): void {
  const flagship = layout.nodes.find((node) => node.vessel.role === 'coordinator');
  if (!flagship) return;
  context.strokeStyle = options.formationLineColor ?? 'rgba(103, 232, 249, 0.18)';
  context.lineWidth = 1;
  context.setLineDash?.([2, 6]);
  for (const node of layout.nodes) {
    if (node.key === flagship.key) continue;
    context.beginPath();
    context.moveTo(flagship.position.x, flagship.position.y);
    context.lineTo(node.position.x, node.position.y);
    context.stroke();
  }
  context.setLineDash?.([]);
}

function drawVessel(
  context: FleetCanvasContext,
  node: FleetFormationLayout['nodes'][number],
  selected: boolean,
  time: number,
): void {
  const { x, y } = node.position;
  const radius = node.hitbox.radius * 0.62;
  const visual = buildVesselVisualState({
    role: node.vessel.role,
    status: node.vessel.status,
    runtime: node.vessel.runtime,
    selected,
    completionPulse: node.vessel.completionPulse,
  });
  const accent = statusColor(node.vessel.status);
  const bob = visual.motion === 'hover' ? Math.sin(time / 800 + node.slot) * 2 : 0;
  const centerY = y + bob;

  if (selected) {
    context.strokeStyle = COLORS.violet;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, centerY, radius + 8, 0, Math.PI * 2);
    context.stroke();
  }

  if (visual.engine === 'active') {
    context.fillStyle = accent;
    context.globalAlpha = 0.72;
    context.fillRect(x - radius * 0.32, centerY + radius * 0.72, radius * 0.64, radius * 0.48);
    context.globalAlpha = 1;
  }

  context.fillStyle = COLORS.hull;
  context.strokeStyle = COLORS.hullHighlight;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(x, centerY - radius);
  context.lineTo(x + radius * 0.84, centerY + radius * 0.52);
  context.lineTo(x, centerY + radius * 0.86);
  context.lineTo(x - radius * 0.84, centerY + radius * 0.52);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = accent;
  context.globalAlpha = 0.9;
  context.fillRect(x - 2, centerY - radius * 0.22, 4, radius * 0.5);
  context.globalAlpha = 1;

  if (visual.beacon !== 'none') {
    context.fillStyle = accent;
    context.beginPath();
    context.arc(x, centerY - radius * 0.7, 3, 0, Math.PI * 2);
    context.fill();
  }

  if (visual.completionPulse) {
    const progress = node.vessel.completionPulseProgress ?? 0;
    context.strokeStyle = COLORS.cyan;
    context.lineWidth = 2;
    context.globalAlpha = Math.max(0, 0.9 - progress);
    context.beginPath();
    context.arc(x, centerY, radius * (1.2 + progress * 0.8), 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
  }

  if ((node.vessel.droneCount ?? 0) > 0) {
    context.fillStyle = COLORS.violet;
    for (let index = 0; index < Math.min(node.vessel.droneCount ?? 0, 4); index += 1) {
      const angle = time / 1400 + index * (Math.PI / 2);
      context.beginPath();
      context.arc(
        x + Math.cos(angle) * radius * 1.25,
        centerY + Math.sin(angle) * radius * 0.7,
        3,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }
}

export function drawFleetFormation(
  context: FleetCanvasContext,
  layout: FleetFormationLayout,
  options: FleetCanvasRendererOptions = {},
  selectedKey: string | null = null,
  time = 0,
): void {
  context.clearRect(0, 0, layout.viewport.width, layout.viewport.height);
  context.fillStyle = options.backgroundColor ?? '#07111f';
  context.fillRect(0, 0, layout.viewport.width, layout.viewport.height);
  drawFormationGrid(context, layout, options);
  drawRegionBounds(context, layout, options);
  drawFormationLines(context, layout, options);
  for (const node of layout.nodes) {
    drawVessel(context, node, node.key === selectedKey, time);
  }
}

export function createFleetCanvasRenderer(
  options: FleetCanvasRendererOptions = {},
): FleetCanvasRenderer {
  return {
    render(context, frame) {
      const layout = computeFleetFormation(
        frame.vessels,
        { width: frame.width, height: frame.height },
        frame.previousSlots,
        options,
      );
      drawFleetFormation(context, layout, options, frame.selectedKey ?? null, frame.time ?? 0);
      return layout;
    },
    hitTest(point, layout) {
      return hitTestFleetFormation(point, layout);
    },
  };
}
