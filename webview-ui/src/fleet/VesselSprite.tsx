import './VesselSprite.css';

import { useId } from 'react';

import type { FleetRuntime } from '../../../core/src/runtimeContracts.js';
import { getVesselAssetSet } from './assets/index.js';
import { buildVesselVisualState, type VesselRole } from './visualState.js';

export interface VesselSpriteProps {
  role: VesselRole;
  status: string;
  runtime?: FleetRuntime | string;
  selected?: boolean;
  completionPulse?: boolean;
  className?: string;
  label?: string;
}

const ROLE_LABELS: Record<VesselRole, string> = {
  coordinator: 'Coordinator flagship',
  worker: 'Worker frigate',
  reviewer: 'Reviewer recon vessel',
  debugger: 'Debugger engineering vessel',
  subagent: 'Subagent drone',
  external: 'External vessel',
};

function joinClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function RoleModule({ role }: { role: VesselRole }) {
  return (
    <>
      <g className="vessel-sprite__role-modules" data-active-role={role}>
        <g data-role-module="coordinator" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-fill" d="M94 42h52l10 13H84l10-13Z" />
          <path className="vessel-sprite__module-edge" d="M94 42h52l10 13H84l10-13Z" />
          <path className="vessel-sprite__module-window" d="M105 47h30l5 5h-40l5-5Z" />
          <path className="vessel-sprite__module-line" d="M120 42v-9" />
          <circle className="vessel-sprite__module-signal" cx="120" cy="30" r="3" />
        </g>

        <g data-role-module="worker" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-fill" d="m54 58-31 12 29 7 15-10-13-9Z" />
          <path className="vessel-sprite__module-edge" d="m54 58-31 12 29 7 15-10-13-9Z" />
          <path className="vessel-sprite__module-fill" d="m186 58 31 12-29 7-15-10 13-9Z" />
          <path className="vessel-sprite__module-edge" d="m186 58 31 12-29 7-15-10 13-9Z" />
        </g>

        <g data-role-module="reviewer" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-line" d="M120 46V19" />
          <circle className="vessel-sprite__sensor-ring" cx="120" cy="16" r="7" />
          <circle className="vessel-sprite__module-signal" cx="120" cy="16" r="2.5" />
          <path className="vessel-sprite__sensor-line" d="M108 29h24" />
        </g>

        <g data-role-module="debugger" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-fill" d="M65 59h-24v18h24l8-9-8-9Z" />
          <path className="vessel-sprite__module-edge" d="M65 59h-24v18h24l8-9-8-9Z" />
          <path className="vessel-sprite__module-line" d="M48 63v10m7-10v10" />
          <path className="vessel-sprite__module-fill" d="M175 59h24v18h-24l-8-9 8-9Z" />
          <path className="vessel-sprite__module-edge" d="M175 59h24v18h-24l8-9-8-9Z" />
          <path className="vessel-sprite__module-line" d="M192 63v10m-7-10v10" />
        </g>

        <g data-role-module="subagent" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-fill" d="M104 47h32l8 15-24 11-24-11 8-15Z" />
          <path className="vessel-sprite__module-edge" d="M104 47h32l8 15-24 11-24-11 8-15Z" />
          <circle className="vessel-sprite__module-signal" cx="120" cy="59" r="4" />
        </g>

        <g data-role-module="external" className="vessel-sprite__role-module">
          <path className="vessel-sprite__module-line" d="M120 47V26" />
          <path className="vessel-sprite__sensor-line" d="M112 28h16" />
          <circle className="vessel-sprite__module-signal" cx="120" cy="22" r="3" />
        </g>
      </g>
    </>
  );
}

/**
 * A small, logo-derived hard-surface vessel. The hull geometry is shared across
 * statuses; role modules establish the vessel class while CSS owns live state.
 */
export function VesselSprite({
  role,
  status,
  runtime,
  selected,
  completionPulse,
  className,
  label,
}: VesselSpriteProps) {
  const visualState = buildVesselVisualState({ role, status, runtime, selected, completionPulse });
  const assetSet = getVesselAssetSet(visualState.vesselType);
  const statusLabel = visualState.status[0].toUpperCase() + visualState.status.slice(1);
  const ariaLabel = label ?? `${ROLE_LABELS[role]} — ${statusLabel}`;
  const instanceId = useId().replaceAll(':', '');
  const hullGradientId = `vessel-hull-gradient-${instanceId}`;
  const coreGradientId = `vessel-core-gradient-${instanceId}`;

  return (
    <span
      className={joinClasses('vessel-sprite', className)}
      data-testid="vessel-sprite"
      data-role={role}
      data-vessel-type={visualState.vesselType}
      data-runtime={visualState.runtimeBadge?.toLowerCase() ?? 'none'}
      data-status={visualState.status}
      data-engine={visualState.engine}
      data-beacon={visualState.beacon}
      data-motion={visualState.motion}
      data-selected={visualState.selected ? 'true' : 'false'}
      data-completion-pulse={visualState.completionPulse ? 'true' : 'false'}
      data-asset-base={assetSet.base.id}
      data-asset-engine={assetSet.engine[visualState.engine].id}
      data-asset-beacon={assetSet.beacon[visualState.beacon].id}
    >
      <svg
        className="vessel-sprite__graphic"
        viewBox="0 0 240 144"
        role="img"
        aria-label={ariaLabel}
        focusable="false"
      >
        <title>{ariaLabel}</title>
        <defs>
          <linearGradient id={hullGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--vessel-hull-light)" />
            <stop offset="0.48" stopColor="var(--vessel-hull-mid)" />
            <stop offset="1" stopColor="var(--vessel-hull-dark)" />
          </linearGradient>
          <linearGradient id={coreGradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--vessel-cyan)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--vessel-cyan)" />
            <stop offset="1" stopColor="var(--vessel-violet)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g className="vessel-sprite__motion">
          <path
            className="vessel-sprite__shadow"
            d="M29 105h182l-18 12H47l-18-12Z"
            aria-hidden="true"
          />
          <g className="vessel-sprite__thruster" aria-hidden="true">
            <path className="vessel-sprite__thruster-flare" d="M63 82 34 94l29 3 14-7-14-8Z" />
            <path className="vessel-sprite__thruster-flare" d="m177 82 29 12-29 3-14-7 14-8Z" />
            <path className="vessel-sprite__thruster-core" d="M65 84 46 92h25l8-4-14-4Z" />
            <path className="vessel-sprite__thruster-core" d="m175 84 19 8h-25l-8-4 14-4Z" />
          </g>

          <path
            className="vessel-sprite__hull"
            d="M26 72 49 54l42-15h58l42 15 23 18-20 25-35 12H81L46 97 26 72Z"
            fill={`url(#${hullGradientId})`}
          />
          <path className="vessel-sprite__hull-edge" d="m26 72 20 25 35 12h78l35-12 20-25" />
          <path className="vessel-sprite__keel" d="m70 94 14 8h72l14-8" />
          <path className="vessel-sprite__spine" d="M75 68h90" />
          <path
            className="vessel-sprite__panel-line"
            d="m54 58 19 11m-8-1 14 16m-3-24 12 9m78-11-19 11m8-1-14 16m3-24-12 9"
          />
          <path
            className="vessel-sprite__core"
            d="M82 72h76l-9 18H91l-9-18Z"
            fill={`url(#${coreGradientId})`}
          />
          <path className="vessel-sprite__core-line" d="M96 78h48m-43 6h38" />

          <RoleModule role={role} />

          {visualState.runtimeBadge ? (
            <g className="vessel-sprite__runtime-badge" aria-hidden="true">
              <rect x="102" y="107" width="36" height="11" rx="1" />
              <text x="120" y="115" textAnchor="middle">
                {visualState.runtimeBadge}
              </text>
            </g>
          ) : null}

          <ellipse
            className="vessel-sprite__selection-ring"
            cx="120"
            cy="106"
            rx="95"
            ry="13"
            aria-hidden="true"
          />

          {visualState.completionPulse ? (
            <circle
              className="vessel-sprite__completion-pulse"
              cx="120"
              cy="72"
              r="34"
              aria-hidden="true"
            />
          ) : null}

          <g className="vessel-sprite__lights" aria-hidden="true">
            <circle className="vessel-sprite__status-light" cx="62" cy="77" r="3" />
            <circle className="vessel-sprite__status-light" cx="178" cy="77" r="3" />
            <circle
              className="vessel-sprite__status-light vessel-sprite__status-light--violet"
              cx="120"
              cy="95"
              r="3"
            />
          </g>

          <g className="vessel-sprite__alarm" aria-hidden="true">
            <path d="M114 63h12l5 6-5 6h-12l-5-6 5-6Z" />
            <path d="M120 65v5m0 2v1" />
          </g>
          <path className="vessel-sprite__scanline" d="M45 48h150" aria-hidden="true" />
        </g>
      </svg>
    </span>
  );
}
