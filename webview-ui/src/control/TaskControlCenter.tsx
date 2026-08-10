import './TaskControlCenter.css';

import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import type { FleetCommandAction } from '../fleet/FleetCommand.js';
import { roleLabel, statusLabel } from '../fleet/localization.js';
import type { FleetAgentModel, FleetSceneModel } from '../fleet/model.js';

interface TaskControlCenterProps {
  model: FleetSceneModel;
  selectedAgent: number | null;
  onSelectAgent: (id: number) => void;
  onFocusAgent: (id: number) => void;
  onAction: (action: FleetCommandAction, id: number) => void;
  onNewAgent: () => void;
  onClearSelection: () => void;
  isSettingsOpen?: boolean;
  onToggleSettings?: () => void;
}

function valueOrPlaceholder(value: string): string {
  return value === '—' ? '未采集' : value;
}

function connectionLabel(connection: FleetAgentModel['connection']): string {
  switch (connection) {
    case 'connected':
      return '终端已连接';
    case 'disconnected':
      return '终端未连接';
    default:
      return '正在连接';
  }
}

function connectionCheckLabel(state: FleetAgentModel['connectionStack'][number]['state']): string {
  switch (state) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'disconnected':
      return '未连接';
    default:
      return '不适用';
  }
}

function formatElapsed(createdAt: number | undefined, now: number): string {
  if (createdAt === undefined) return '未采集';
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="control-detail-field">
      <span>{label}</span>
      <strong>{valueOrPlaceholder(value)}</strong>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
  now,
}: {
  agent: FleetAgentModel;
  selected: boolean;
  onSelect: (id: number) => void;
  now: number;
}) {
  return (
    <button
      type="button"
      className={`control-agent-row ${selected ? 'is-selected' : ''}`}
      data-testid={`control-agent-${agent.id}`}
      onClick={() => onSelect(agent.id)}
    >
      <span className="control-agent-identity">
        <span className="control-status-indicator" data-status={agent.status} aria-hidden="true" />
        <span>
          <strong>{agent.displayName ?? `${roleLabel(agent.role)} #${agent.id}`}</strong>
          <small>
            {agent.runtimeLabel} · {agent.model === '—' ? roleLabel(agent.role) : agent.model}
          </small>
        </span>
      </span>
      <span className="control-agent-progress">
        <strong>{statusLabel(agent.status)}</strong>
        <small>
          {agent.currentTask !== '—' ? agent.currentTask : agent.executionLabel}
          {agent.currentTool !== '—' ? ` · ${agent.currentTool}` : ''}
        </small>
      </span>
      <span className="control-agent-elapsed">
        <strong>{formatElapsed(agent.createdAt, now)}</strong>
        <small>运行时间</small>
      </span>
      <span className="control-agent-usage">
        <strong>{valueOrPlaceholder(agent.usage)}</strong>
        <small>Token 总量</small>
      </span>
      <span className="control-agent-connection" data-connection={agent.connection}>
        <i aria-hidden="true" />
        <span>{connectionLabel(agent.connection)}</span>
      </span>
      <span className="control-agent-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function MissionSummary({ model }: { model: FleetSceneModel }) {
  const mission = model.mission;
  const taskProgress =
    mission.completedTasks !== null && mission.totalTasks !== null
      ? `${mission.completedTasks} / ${mission.totalTasks}`
      : '未接入';

  return (
    <section className="control-summary-card" data-testid="control-mission-summary">
      <div className="control-section-kicker">当前任务</div>
      <div className="control-mission-title">
        {mission.title === 'No active mission' ? '暂无活动任务' : mission.title}
      </div>
      <div className="control-mission-objective">
        {mission.objective === 'Awaiting mission context'
          ? '等待主控 Session 分配任务'
          : mission.objective}
      </div>
      <div className="control-mission-metrics">
        <span>
          <small>任务进度</small>
          <strong>{taskProgress}</strong>
        </span>
        <span>
          <small>运行时间</small>
          <strong>{mission.wallClock === '—' ? '未采集' : mission.wallClock}</strong>
        </span>
        <span>
          <small>PR</small>
          <strong>{mission.openPullRequests === null ? '未接入' : mission.openPullRequests}</strong>
        </span>
      </div>
    </section>
  );
}

function SelectedAgentPanel({
  agent,
  onFocusAgent,
  onAction,
  onClose,
  now,
}: {
  agent: FleetAgentModel;
  onFocusAgent: (id: number) => void;
  onAction: (action: FleetCommandAction, id: number) => void;
  onClose: () => void;
  now: number;
}) {
  return (
    <aside className="control-selected-panel" data-testid="control-agent-detail">
      <div className="control-selected-heading">
        <div>
          <div className="control-section-kicker">Agent 详情</div>
          <h2>{agent.displayName ?? `${roleLabel(agent.role)} #${agent.id}`}</h2>
          <p>
            {roleLabel(agent.role)} · {statusLabel(agent.status)}
          </p>
        </div>
        <button type="button" className="control-close" aria-label="关闭详情" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="control-detail-grid">
        <DetailField label="运行时" value={agent.runtimeLabel} />
        <DetailField label="Provider" value={agent.provider} />
        <DetailField label="Model" value={agent.model} />
        <DetailField label="状态" value={statusLabel(agent.status)} />
        <DetailField label="连接" value={connectionLabel(agent.connection)} />
        <DetailField label="当前工作" value={agent.currentTask} />
        <DetailField label="当前动作" value={agent.executionLabel} />
        <DetailField label="当前工具" value={agent.currentTool} />
        <DetailField
          label="运行时间"
          value={agent.createdAt ? formatElapsed(agent.createdAt, now) : '—'}
        />
        <DetailField label="仓库" value={agent.repo} />
        <DetailField label="Token 总量" value={agent.usage} />
        <DetailField label="输入 Token" value={agent.inputTokens} />
        <DetailField label="缓存 Token" value={agent.cachedTokens} />
        <DetailField label="输出 Token" value={agent.outputTokens} />
        <DetailField label="上下文" value={agent.context} />
        <DetailField label="会话" value={agent.session} />
      </div>
      <div className="control-connection-stack">
        <div className="control-detail-section-title">连接诊断</div>
        {agent.connectionStack.map((check) => (
          <div className="control-connection-row" key={check.label}>
            <span>{check.label}</span>
            <strong data-state={check.state}>
              <i aria-hidden="true" />
              {connectionCheckLabel(check.state)}
            </strong>
            {check.detail ? <small>{check.detail}</small> : null}
          </div>
        ))}
      </div>
      <div className="control-detail-actions">
        <Button
          variant="accent"
          size="sm"
          className="control-focus-action"
          data-testid={`control-agent-focus-${agent.id}`}
          onClick={() => onFocusAgent(agent.focusAgentId)}
        >
          聚焦终端
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`control-agent-restart-${agent.id}`}
          onClick={() => onAction('restartAgent', agent.commandAgentId)}
        >
          重启
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`control-agent-switch-provider-${agent.id}`}
          onClick={() => onAction('switchProvider', agent.commandAgentId)}
        >
          切换 Provider
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`control-agent-stop-${agent.id}`}
          onClick={() => onAction('stopAgent', agent.commandAgentId)}
        >
          停止
        </Button>
      </div>
    </aside>
  );
}

export function TaskControlCenter({
  model,
  selectedAgent,
  onSelectAgent,
  onFocusAgent,
  onAction,
  onNewAgent,
  onClearSelection,
  isSettingsOpen,
  onToggleSettings,
}: TaskControlCenterProps) {
  const [now, setNow] = useState(() => Date.now());
  const selected = model.agents.find((agent) => agent.id === selectedAgent) ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main
      className="task-control-center"
      data-testid="task-control-center"
      aria-label="任务控制中心"
    >
      <header className="control-header">
        <div>
          <div className="control-product-label">AGENT FLEET · CONTROL PLANE</div>
          <h1>任务控制中心</h1>
          <p>集中查看 Agent 进度、运行状态、终端和任务结果</p>
        </div>
        <div className="control-header-actions">
          <div className="control-header-stat">
            <strong>{model.agents.length}</strong>
            <span>Agent</span>
          </div>
          <div className="control-header-stat is-working">
            <strong>{model.workingCount}</strong>
            <span>工作中</span>
          </div>
          <div className="control-header-stat">
            <strong>{model.waitingCount}</strong>
            <span>等待</span>
          </div>
          <Button
            variant="accent"
            size="sm"
            className="control-primary-action"
            onClick={onNewAgent}
            data-testid="control-center-new-agent"
          >
            + 新建 Agent
          </Button>
          {onToggleSettings ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="fleet-settings"
              aria-pressed={isSettingsOpen}
              onClick={onToggleSettings}
            >
              设置
            </Button>
          ) : null}
        </div>
      </header>

      <div className="control-content">
        <div className="control-main-column">
          <MissionSummary model={model} />
          <section
            className="control-summary-card control-agent-list-card"
            data-testid="control-agent-list-card"
          >
            <div className="control-section-heading">
              <div>
                <div className="control-section-kicker">运行队列</div>
                <h2>Agent 进度</h2>
              </div>
              <span>
                {model.agents.length === 0 ? '暂无实例' : `${model.agents.length} 个实例`}
              </span>
            </div>
            {model.agents.length === 0 ? (
              <div className="control-empty" data-testid="control-center-empty">
                <strong>还没有运行中的 Agent</strong>
                <span>从这里创建一个独立终端，开始受控执行。</span>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onNewAgent}
                  data-testid="control-empty-new-agent"
                >
                  + 新建 Agent
                </Button>
              </div>
            ) : (
              <div className="control-agent-list">
                {model.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === selectedAgent}
                    onSelect={onSelectAgent}
                    now={now}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="control-side-column">
          {selected ? (
            <SelectedAgentPanel
              agent={selected}
              onFocusAgent={onFocusAgent}
              onAction={onAction}
              onClose={onClearSelection}
              now={now}
            />
          ) : (
            <section
              className="control-summary-card control-info-card"
              data-testid="control-overview-card"
            >
              <div className="control-section-kicker">运行总览</div>
              <h2>选择一个 Agent 查看详情</h2>
              <p>状态、当前工作、Token、上下文和终端操作会在这里集中显示。</p>
              <div className="control-status-summary">
                <span>
                  <i data-status="Working" />
                  工作中 {model.workingCount}
                </span>
                <span>
                  <i data-status="Waiting" />
                  等待 {model.waitingCount}
                </span>
                <span>
                  <i data-status="Idle" />
                  空闲 {Math.max(0, model.agents.length - model.workingCount - model.waitingCount)}
                </span>
              </div>
            </section>
          )}
          <section
            className="control-summary-card control-events-card"
            data-testid="control-recent-events"
          >
            <div className="control-section-kicker">最近活动</div>
            {model.recentEvents.length === 0 ? (
              <p className="control-muted">暂无实时事件</p>
            ) : (
              <div className="control-events">
                {model.recentEvents.slice(0, 6).map((event, index) => (
                  <div key={`${event.label}-${event.observedAt ?? index}`}>
                    <span>{event.agentId === undefined ? 'Fleet' : `Agent #${event.agentId}`}</span>
                    <strong>{event.label}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
