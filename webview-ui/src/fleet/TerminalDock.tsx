import './DockAndTimeline.css';

import { statusLabel } from './localization.js';

export type FleetInstanceId = number | string;

export interface TerminalDockInstance {
  id: FleetInstanceId;
  label: string;
  roleLabel?: string;
  status: string;
  terminalName?: string;
  /** The transport layer is the source of truth for terminal availability. */
  terminalAvailable: boolean;
}

export interface TerminalDockProps {
  instances: readonly TerminalDockInstance[];
  selectedInstanceId: FleetInstanceId | null;
  onSelectInstance: (instanceId: FleetInstanceId) => void;
  onFocusTerminal: (instanceId: FleetInstanceId) => void;
  onNewAgent: () => void;
  compact?: boolean;
}

function instanceTestId(id: FleetInstanceId): string {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function TerminalDock({
  instances,
  selectedInstanceId,
  onSelectInstance,
  onFocusTerminal,
  onNewAgent,
  compact = false,
}: TerminalDockProps) {
  return (
    <section
      className={`fleet-terminal-dock ${compact ? 'fleet-terminal-dock-compact' : ''}`}
      data-testid="terminal-dock"
      aria-label="终端停靠"
    >
      <div className="fleet-bottom-section-heading">
        <div>
          <div className="fleet-section-kicker">运行时终端</div>
          <h2 className="fleet-section-title">终端停靠</h2>
        </div>
        <span className="fleet-section-caption">选择 Agent 查看详情，需要介入时聚焦对应终端。</span>
      </div>

      <div className="fleet-terminal-dock-list" role="list">
        {instances.map((instance) => {
          const testId = instanceTestId(instance.id);
          const selected = instance.id === selectedInstanceId;
          return (
            <div
              key={String(instance.id)}
              className={`fleet-terminal-entry ${selected ? 'fleet-terminal-entry-selected' : ''}`}
              data-testid={`terminal-dock-entry-${testId}`}
              role="listitem"
            >
              <button
                type="button"
                className="fleet-terminal-select"
                data-testid={`terminal-dock-select-${testId}`}
                aria-pressed={selected}
                onClick={() => onSelectInstance(instance.id)}
              >
                <span
                  className="fleet-terminal-status-dot"
                  data-status={instance.status.toLowerCase()}
                  title={statusLabel(instance.status)}
                  aria-hidden="true"
                />
                <span className="fleet-terminal-select-copy">
                  <span className="fleet-terminal-instance-label">{instance.label}</span>
                  {instance.roleLabel ? (
                    <span className="fleet-terminal-instance-role">{instance.roleLabel}</span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                className="fleet-terminal-focus"
                data-testid={`terminal-dock-focus-${testId}`}
                aria-label={`聚焦终端：${instance.label}`}
                title={instance.terminalAvailable ? '聚焦终端' : '终端不可用'}
                disabled={!instance.terminalAvailable}
                onClick={() => onFocusTerminal(instance.id)}
              >
                {instance.terminalAvailable ? '聚焦' : '无终端'}
              </button>
              {instance.terminalName ? (
                <span className="fleet-terminal-name" title={instance.terminalName}>
                  {instance.terminalName}
                </span>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          className="fleet-terminal-new-agent"
          data-testid="terminal-dock-new-agent"
          onClick={onNewAgent}
        >
          <span className="fleet-terminal-new-agent-mark" aria-hidden="true">
            +
          </span>
          <span>新建 Agent</span>
        </button>
      </div>
    </section>
  );
}
