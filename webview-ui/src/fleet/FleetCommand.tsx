import './FleetCommand.css';
import './VesselSprite.css';

import { Button } from '../components/ui/Button.js';
import { FleetFormationCanvas } from './FleetFormationCanvas.js';
import { FleetTimeline, type FleetTimelineEvent } from './FleetTimeline.js';
import { roleLabel, statusLabel, vesselLabel } from './localization.js';
import { MissionSidebar } from './MissionSidebar.js';
import type { FleetAgentModel, FleetSceneModel } from './model.js';
import { TerminalDock, type TerminalDockInstance } from './TerminalDock.js';
import { VesselSprite } from './VesselSprite.js';

export type FleetCommandAction = 'restartAgent' | 'switchProvider' | 'stopAgent';

interface FleetCommandProps {
  model: FleetSceneModel;
  selectedAgent: number | null;
  onSelectAgent?: (id: number) => void;
  onFocusAgent: (id: number) => void;
  onAction: (action: FleetCommandAction, id: number) => void;
  onNewAgent: () => void;
  onClearSelection?: () => void;
  isSettingsOpen?: boolean;
  onToggleSettings?: () => void;
}

function VesselCard({
  agent,
  selected,
  onSelectAgent,
}: {
  agent: FleetAgentModel;
  selected: boolean;
  onSelectAgent: (id: number) => void;
}) {
  const select = () => onSelectAgent(agent.id);
  return (
    <div
      className={`fleet-vessel ${selected ? 'fleet-vessel-selected' : ''}`}
      data-testid={`fleet-vessel-${agent.id}`}
      data-role={agent.role}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        }
      }}
      aria-label={`${roleLabel(agent.role)} ${agent.id}，${statusLabel(agent.status)}`}
    >
      <div className="fleet-vessel-visual">
        <VesselSprite
          role={agent.role}
          status={agent.status}
          runtime={agent.runtime}
          selected={selected}
          label={`${roleLabel(agent.role)} ${agent.id}，${statusLabel(agent.status)}`}
        />
      </div>
      <div className="fleet-vessel-label-row">
        <span className="fleet-vessel-name">
          {roleLabel(agent.role)} #{agent.id}
        </span>
        <span
          className="fleet-status-dot"
          data-status={agent.status}
          title={agent.status}
          aria-label={agent.status}
        />
      </div>
      <div className="fleet-vessel-meta">
        <span>{vesselLabel(agent.role)}</span>
        <span>{statusLabel(agent.status)}</span>
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="break-all text-right">{value}</span>
    </div>
  );
}

function toMissionProps(model: FleetSceneModel) {
  const mission = model.mission;
  const coordinator = mission.coordinator;
  return {
    mission: {
      title: mission.title,
      goal: mission.objective,
      taskProgress: { completed: mission.completedTasks, total: mission.totalTasks },
      activeAgents: model.agents.length,
      openPRs: mission.openPullRequests,
      wallClock: mission.wallClock,
      agentTime: mission.agentTime,
    },
    coordinator: coordinator
      ? {
          name: `${roleLabel(coordinator.role)} #${coordinator.id}`,
          role: roleLabel(coordinator.role),
          runtime: coordinator.runtimeLabel,
          status: coordinator.status,
          external: coordinator.managed === 'External',
        }
      : null,
    resources: mission.resources.map((resource, index) => ({
      id: `${resource.label}-${index}`,
      label: resource.label,
      value: resource.value,
      detail: resource.detail,
      tone: 'neutral' as const,
    })),
  };
}

function toTerminalInstances(model: FleetSceneModel): TerminalDockInstance[] {
  return model.agents.map((agent) => ({
    id: agent.id,
    label: `${roleLabel(agent.role)} #${agent.id}`,
    roleLabel: vesselLabel(agent.role),
    status: agent.status,
    terminalName: agent.terminalName === '—' ? undefined : agent.terminalName,
    terminalAvailable: agent.terminalAvailable,
  }));
}

function toTimelineEvents(model: FleetSceneModel): FleetTimelineEvent[] {
  return model.recentEvents.map((event, index) => ({
    id: `${event.agentId ?? 'fleet'}-${event.observedAt ?? 'unknown'}-${index}`,
    observedAt: event.observedAt ?? Number.NaN,
    agentLabel: event.agentId === undefined ? '舰队' : `Agent #${event.agentId}`,
    label: event.label,
  }));
}

export function FleetCommand({
  model,
  selectedAgent,
  onSelectAgent,
  onFocusAgent,
  onAction,
  onNewAgent,
  onClearSelection,
  isSettingsOpen,
  onToggleSettings,
}: FleetCommandProps) {
  const selectedId = selectedAgent;
  const selected =
    selectedAgent === null
      ? null
      : (model.agents.find((agent) => agent.id === selectedAgent) ?? null);
  const selectAgent = onSelectAgent ?? onFocusAgent;
  const missionProps = toMissionProps(model);
  const terminalInstances = toTerminalInstances(model);

  return (
    <main
      className="fleet-command-scene absolute inset-0 overflow-auto"
      data-testid="fleet-command-scene"
      aria-label="任务控制中心"
    >
      <div className="fleet-command-dashboard">
        <header className="fleet-command-header">
          <div className="fleet-command-identity">
            <div className="fleet-brand-eyebrow">AGENT FLEET</div>
            <div>
              <h1>任务控制中心</h1>
              <span className="fleet-command-subtitle">Agent 进度、终端与任务管理</span>
            </div>
            <span className="fleet-command-mission" data-testid="fleet-mission-context">
              <span className="fleet-command-mission-label">任务</span>
              <strong>
                {model.mission.title === 'No active mission' ? '暂无活动任务' : model.mission.title}
              </strong>
            </span>
          </div>
          <div className="fleet-command-header-stats">
            <span>
              <strong>{model.agents.length}</strong> 活跃
            </span>
            <span>
              <strong>{model.workingCount}</strong> 工作中
            </span>
            {model.waitingCount > 0 ? (
              <span>
                <strong>{model.waitingCount}</strong> 等待
              </span>
            ) : null}
            {model.mission.openPullRequests !== null ? (
              <span>
                <strong>{model.mission.openPullRequests}</strong> PR
              </span>
            ) : null}
            <Button variant="accent" size="sm" onClick={onNewAgent} data-testid="fleet-new-agent">
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

        <div
          className={`fleet-command-layout ${selected ? 'fleet-command-layout-with-detail' : ''}`}
        >
          <MissionSidebar {...missionProps} compact />

          <section className="fleet-command-center" aria-label="Fleet vessels">
            <FleetFormationCanvas
              agents={model.agents}
              selectedAgentId={selected?.id ?? null}
              telemetryEvents={model.telemetryEvents}
              onSelectAgent={selectAgent}
            />
            <div className="fleet-center-heading">
              <div className="fleet-center-title">
                <span className="fleet-brand-eyebrow">实时编队</span>
                <h2>舰队场景</h2>
              </div>
              <span>
                {model.groups.length} 个区域 · {model.agents.length} 艘舰船
              </span>
            </div>

            {model.agents.length === 0 ? (
              <div className="fleet-empty-state" data-testid="empty-state">
                <div className="fleet-station-mark" aria-hidden="true">
                  ◇
                </div>
                <div className="text-3xl font-bold">编队中暂无 Agent</div>
                <div className="text-lg text-text-muted mt-3">舰队指挥中心待命。</div>
                <button
                  data-testid="empty-state-new-agent"
                  onClick={onNewAgent}
                  className="mt-8 py-4 px-12 text-xl bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel hover:opacity-90"
                >
                  + 新建 Agent
                </button>
              </div>
            ) : (
              <div className="fleet-region-list">
                {model.groups.map((group) => (
                  <section
                    key={group.repo}
                    className="fleet-region"
                    data-testid={`fleet-region-${group.repo}`}
                  >
                    <div className="fleet-region-heading">
                      <div>
                        <h3>{group.repo}</h3>
                        <span>运行区域 · 真实仓库</span>
                      </div>
                      <span>{group.agents.length} 艘</span>
                    </div>
                    <div className="fleet-vessel-formation">
                      {group.agents.map((agent) => (
                        <VesselCard
                          key={agent.id}
                          agent={agent}
                          selected={selected?.id === agent.id}
                          onSelectAgent={selectAgent}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>

          {selected ? (
            <aside
              className="fleet-detail-panel"
              aria-label="Agent telemetry"
              data-testid="fleet-detail-panel"
            >
              {selected ? (
                <>
                  <div className="fleet-detail-heading">
                    <div>
                      <div className="fleet-detail-kicker">实例详情</div>
                      <h2>
                        {roleLabel(selected.role)} #{selected.id}
                      </h2>
                      <div className="fleet-detail-subtitle">
                        {roleLabel(selected.role)} · {statusLabel(selected.status)}
                      </div>
                    </div>
                    <div className="fleet-detail-heading-actions">
                      <span className="fleet-status-dot" data-status={selected.status} />
                      <button
                        type="button"
                        className="fleet-detail-close"
                        data-testid="fleet-detail-close"
                        aria-label="关闭实例详情"
                        onClick={() => onClearSelection?.()}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className="fleet-detail-fields">
                    <DetailField label="运行时" value={selected.runtimeLabel} />
                    <DetailField label="角色" value={roleLabel(selected.role)} />
                    <DetailField label="状态" value={statusLabel(selected.status)} />
                    <DetailField label="仓库" value={selected.repo} />
                    <DetailField label="工作目录" value={selected.cwd} />
                    <DetailField label="工作树" value={selected.worktree} />
                    <DetailField label="Provider" value={selected.provider} />
                    <DetailField label="Model" value={selected.model} />
                    <DetailField label="会话" value={selected.session} />
                    <DetailField label="任务" value={selected.currentTask} />
                    <DetailField label="工具" value={selected.currentTool} />
                    <DetailField label="上下文" value={selected.context} />
                    <DetailField label="用量" value={selected.usage} />
                    <DetailField
                      label="管理方式"
                      value={selected.managed === 'External' ? '外部' : 'Fleet 管理'}
                    />
                  </div>
                  <div className="fleet-detail-telemetry">
                    <div className="fleet-detail-label">最近遥测</div>
                    <div className="fleet-detail-event-list">
                      {selected.recentEvents.map((event, index) => (
                        <div key={`${event.label}-${index}`} className="flex gap-3">
                          <span className="text-accent-bright">›</span>
                          <span>{event.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="fleet-detail-actions">
                    <Button
                      variant="accent"
                      size="sm"
                      data-testid={`fleet-agent-focus-${selected.id}`}
                      onClick={() => onFocusAgent(selected.focusAgentId)}
                    >
                      聚焦终端
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`fleet-agent-restart-${selected.id}`}
                      onClick={() => onAction('restartAgent', selected.commandAgentId)}
                    >
                      重启
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`fleet-agent-switch-provider-${selected.id}`}
                      onClick={() => onAction('switchProvider', selected.commandAgentId)}
                    >
                      切换 Provider
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`fleet-agent-stop-${selected.id}`}
                      onClick={() => onAction('stopAgent', selected.commandAgentId)}
                    >
                      停止
                    </Button>
                  </div>
                </>
              ) : null}
            </aside>
          ) : null}
        </div>

        <TerminalDock
          instances={terminalInstances}
          selectedInstanceId={selectedId}
          onSelectInstance={(id) => selectAgent(Number(id))}
          onFocusTerminal={(id) => onFocusAgent(Number(id))}
          onNewAgent={onNewAgent}
          compact
        />
        <FleetTimeline events={toTimelineEvents(model)} compact />
      </div>
    </main>
  );
}
