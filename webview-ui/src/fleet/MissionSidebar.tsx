import './MissionSidebar.css';

import { statusLabel } from './localization.js';

export interface MissionTaskProgress {
  completed?: number | null;
  total?: number | null;
}

export interface MissionSummary {
  title?: string | null;
  goal?: string | null;
  taskProgress?: MissionTaskProgress | null;
  activeAgents?: number | null;
  openPRs?: number | null;
  wallClock?: string | null;
  agentTime?: string | null;
}

export interface MissionCoordinator {
  name?: string | null;
  role?: string | null;
  runtime?: string | null;
  status?: string | null;
  external?: boolean | null;
}

export type MissionResourceTone = 'healthy' | 'warning' | 'error' | 'neutral';

export interface MissionResource {
  id: string;
  label?: string | null;
  value?: string | number | null;
  detail?: string | null;
  tone?: MissionResourceTone;
}

export interface MissionSidebarProps {
  mission?: MissionSummary | null;
  coordinator?: MissionCoordinator | null;
  resources?: readonly MissionResource[] | null;
  className?: string;
  compact?: boolean;
}

const EMPTY_VALUE = '—';

function display(value: string | number | null | undefined): string | number {
  return value === null || value === undefined || value === '' ? EMPTY_VALUE : value;
}

function displayProgress(progress: MissionTaskProgress | null | undefined): string {
  if (!progress) return EMPTY_VALUE;
  const completed = display(progress.completed);
  const total = display(progress.total);
  if (completed === EMPTY_VALUE && total === EMPTY_VALUE) return EMPTY_VALUE;
  return `${completed} / ${total}`;
}

function resourceTestId(resource: MissionResource, index: number): string {
  const id = resource.id.trim();
  return `mission-resource-row-${id || index}`;
}

function CoordinatorBlock({ coordinator }: { coordinator?: MissionCoordinator | null }) {
  if (!coordinator) {
    return (
      <section className="mission-sidebar-section" data-testid="mission-coordinator-section">
        <div className="mission-sidebar-section-heading">主控</div>
        <div className="mission-empty-summary" data-testid="mission-coordinator">
          <strong>未分配主控</strong>
          <span>当前任务尚未提供 Coordinator。</span>
        </div>
      </section>
    );
  }
  return (
    <section className="mission-sidebar-section" data-testid="mission-coordinator-section">
      <div className="mission-sidebar-section-heading">主控</div>
      <div className="mission-coordinator-card" data-testid="mission-coordinator">
        <div className="mission-coordinator-identity">
          <span className="mission-coordinator-mark" aria-hidden="true">
            ◆
          </span>
          <div className="mission-coordinator-copy">
            <strong data-testid="mission-coordinator-name">{display(coordinator.name)}</strong>
            <span data-testid="mission-coordinator-role">{display(coordinator.role)}</span>
          </div>
          <span
            className="mission-status-indicator"
            data-status={coordinator.status ?? 'unknown'}
            aria-label={`主控状态：${statusLabel(String(display(coordinator.status)))}`}
          />
        </div>
        <dl className="mission-coordinator-meta">
          <div>
            <dt>运行时</dt>
            <dd data-testid="mission-coordinator-runtime">{display(coordinator.runtime)}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd data-testid="mission-coordinator-status">
              {statusLabel(String(display(coordinator.status)))}
            </dd>
          </div>
          <div>
            <dt>管理方式</dt>
            <dd data-testid="mission-coordinator-access">
              {coordinator?.external === undefined || coordinator.external === null
                ? EMPTY_VALUE
                : coordinator.external
                  ? '外部'
                  : 'Fleet 管理'}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function MissionMetrics({ mission }: { mission?: MissionSummary | null }) {
  const hasMission = Boolean(mission?.title && mission.title !== 'No active mission');
  if (!hasMission) {
    return (
      <section
        className="mission-sidebar-section mission-empty-section"
        data-testid="mission-metrics"
      >
        <div className="mission-sidebar-section-heading">任务状态</div>
        <div className="mission-empty-summary">
          <strong data-testid="mission-empty-title">暂无活动任务</strong>
          <span data-testid="mission-empty-copy">
            检测到 Fleet Run 后，Agent 会自动归入任务编队。
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className="mission-sidebar-section" data-testid="mission-metrics">
      <div className="mission-sidebar-section-heading">任务状态</div>
      <dl className="mission-metrics-grid">
        <div className="mission-metric">
          <dt>任务</dt>
          <dd data-testid="mission-task-progress">{displayProgress(mission?.taskProgress)}</dd>
        </div>
        <div className="mission-metric">
          <dt>活跃 Agent</dt>
          <dd data-testid="mission-active-agents">{display(mission?.activeAgents)}</dd>
        </div>
        <div className="mission-metric">
          <dt>开放 PR</dt>
          <dd data-testid="mission-open-prs">{display(mission?.openPRs)}</dd>
        </div>
        <div className="mission-metric">
          <dt>墙钟时间</dt>
          <dd data-testid="mission-wall-clock">{display(mission?.wallClock)}</dd>
        </div>
        <div className="mission-metric mission-metric-wide">
          <dt>Agent 时间</dt>
          <dd data-testid="mission-agent-time">{display(mission?.agentTime)}</dd>
        </div>
      </dl>
    </section>
  );
}

function ResourceRows({ resources }: { resources?: readonly MissionResource[] | null }) {
  if (!resources?.length) return null;
  return (
    <section className="mission-sidebar-section" data-testid="mission-resources">
      <div className="mission-sidebar-section-heading">资源</div>
      {resources?.length ? (
        <div className="mission-resource-list">
          {resources.map((resource, index) => (
            <div
              className="mission-resource-row"
              data-testid={resourceTestId(resource, index)}
              data-resource-id={resource.id}
              data-tone={resource.tone ?? 'neutral'}
              key={`${resource.id}-${index}`}
            >
              <div className="mission-resource-label">
                <span className="mission-resource-dot" aria-hidden="true" />
                <span>{display(resource.label)}</span>
              </div>
              <div className="mission-resource-value">
                <strong>{display(resource.value)}</strong>
                {resource.detail ? <span>{resource.detail}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mission-resource-empty" data-testid="mission-resource-empty">
          暂无资源数据
        </div>
      )}
    </section>
  );
}

export function MissionSidebar({
  mission,
  coordinator,
  resources,
  className = '',
  compact = false,
}: MissionSidebarProps) {
  return (
    <aside
      className={`mission-sidebar ${compact ? 'mission-sidebar-compact' : ''} ${className}`.trim()}
      data-testid="mission-sidebar"
      aria-label="Mission and coordinator"
    >
      <header className="mission-sidebar-header" data-testid="mission-header">
        <span className="mission-sidebar-eyebrow">任务</span>
        <h1 data-testid="mission-title">
          {mission?.title === 'No active mission' ? '暂无活动任务' : display(mission?.title)}
        </h1>
        <p data-testid="mission-goal">
          {mission?.goal === 'Awaiting mission context' ? '等待任务上下文' : display(mission?.goal)}
        </p>
      </header>
      <CoordinatorBlock coordinator={coordinator} />
      <MissionMetrics mission={mission} />
      <ResourceRows resources={resources} />
    </aside>
  );
}
