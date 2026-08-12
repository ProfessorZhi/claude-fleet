import './FleetFormationCanvas.css';

import { type MouseEvent, useEffect, useMemo, useRef } from 'react';

import type { FleetEvent } from '../../../core/src/fleetTelemetry.js';
import { VisualAnimationController } from './animation/controller.js';
import { getAnimationPerformancePolicy } from './animation/performance.js';
import {
  createFleetCanvasRenderer,
  type FleetFormationLayout,
  type FormationVessel,
} from './canvas/index.js';
import type { FleetAgentModel } from './model.js';

interface FleetFormationCanvasProps {
  agents: readonly FleetAgentModel[];
  selectedAgentId: number | null;
  telemetryEvents?: readonly FleetEvent[];
  onSelectAgent?: (id: number) => void;
}

function toFormationVessel(agent: FleetAgentModel): FormationVessel {
  return {
    id: agent.id,
    key: `${agent.repo}::${agent.id}`,
    repo: agent.repo,
    role: agent.role,
    status: agent.status,
    runtime: agent.runtime,
    label: `${agent.roleLabel} #${agent.id}`,
  };
}

/**
 * Canvas owns the low-frequency world layer (grid, regions, formation lines,
 * and hitboxes). The DOM VesselCards remain above it as the accessible detail
 * projection, so keyboard users and screen readers do not depend on pixels.
 */
export function FleetFormationCanvas({
  agents,
  selectedAgentId,
  telemetryEvents = [],
  onSelectAgent,
}: FleetFormationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<FleetFormationLayout | null>(null);
  const vessels = useMemo(() => agents.map(toFormationVessel), [agents]);
  const animationController = useMemo(() => new VisualAnimationController(), []);
  const renderer = useMemo(
    () =>
      createFleetCanvasRenderer({
        columns: 5,
        padding: 28,
        groupPadding: 18,
      }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;

    let animationFrame = 0;
    let lastPaint = -Infinity;
    let disposed = false;

    const paint = (time: number) => {
      if (disposed) return;
      const isReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const visibility = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
      const performancePolicy = getAnimationPerformancePolicy({
        prefersReducedMotion: isReducedMotion,
        visibility,
      });
      animationController.setPerformance({
        prefersReducedMotion: isReducedMotion,
        visibility,
      });
      for (const event of telemetryEvents) animationController.consume(event);
      const animation = animationController.snapshot(Date.now());
      const completionByAgent = new Map<number, number>();
      for (const effect of animation.effects) {
        if (effect.kind !== 'task-finished-pulse' || effect.target.agentId === undefined) continue;
        completionByAgent.set(effect.target.agentId, effect.progress);
      }
      const dronesByAgent = new Map<number, number>();
      for (const drone of animation.drones) {
        if (drone.parent.agentId === undefined) continue;
        dronesByAgent.set(drone.parent.agentId, (dronesByAgent.get(drone.parent.agentId) ?? 0) + 1);
      }
      const animatedVessels = vessels.map((vessel) => ({
        ...vessel,
        completionPulse: completionByAgent.has(Number(vessel.id)),
        completionPulseProgress: completionByAgent.get(Number(vessel.id)) ?? 0,
        droneCount: dronesByAgent.get(Number(vessel.id)) ?? 0,
      }));
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
      const pixelHeight = Math.max(1, Math.round(height * devicePixelRatio));

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

      const shouldPaint =
        lastPaint === -Infinity ||
        (performancePolicy.scheduleFrames && time - lastPaint >= performancePolicy.frameIntervalMs);
      if (shouldPaint) {
        lastPaint = time;
        layoutRef.current = renderer.render(context, {
          vessels: animatedVessels,
          width,
          height,
          selectedKey:
            selectedAgentId === null
              ? null
              : `${vessels.find((vessel) => vessel.id === selectedAgentId)?.repo ?? '—'}::${selectedAgentId}`,
          time: isReducedMotion ? 0 : time,
        });
      }

      if (performancePolicy.scheduleFrames) animationFrame = window.requestAnimationFrame(paint);
      else animationFrame = 0;
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            lastPaint = -Infinity;
          });
    resizeObserver?.observe(canvas);
    const resume = () => {
      lastPaint = -Infinity;
      if (!disposed && animationFrame === 0 && document.visibilityState !== 'hidden') {
        animationFrame = window.requestAnimationFrame(paint);
      }
    };
    document.addEventListener('visibilitychange', resume);
    animationFrame = window.requestAnimationFrame(paint);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', resume);
    };
  }, [animationController, renderer, selectedAgentId, telemetryEvents, vessels]);

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!onSelectAgent || !layoutRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const point = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
    const node = renderer.hitTest(point, layoutRef.current);
    if (node) onSelectAgent(Number(node.vessel.id));
  };

  return (
    <div className="fleet-formation-canvas-shell" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="fleet-formation-canvas"
        data-testid="fleet-formation-canvas"
        onClick={handleClick}
      />
    </div>
  );
}
