import type {
  FleetEvent,
  FleetTelemetryProjection,
  FleetTelemetrySnapshot,
} from '../../../core/src/fleetTelemetry.js';
import type { AgentRole, FleetRuntime } from '../../../core/src/runtimeContracts.js';
import type { ToolActivity } from '../office/types.js';

export type FleetSceneRole =
  'coordinator' | 'worker' | 'reviewer' | 'debugger' | 'subagent' | 'external';

export interface FleetCharacterMetadata {
  folderName?: string;
  createdAt?: number;
  currentTool?: string | null;
  isSubagent?: boolean;
  parentAgentId?: number | null;
  isTeamLead?: boolean;
  agentName?: string;
  displayName?: string;
  isHeadless?: boolean;
  contextTokens?: number;
  maxContextTokens?: number;
  usageTokens?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** The current turn is blocked waiting for explicit user input. */
  waitingAwaitingInput?: boolean;
  /** A completed turn has not been opened in the current projection. */
  completionUnread?: boolean;
}

export interface FleetAgentFolder {
  name: string;
  path: string;
}

export interface FleetSceneInput {
  agents: number[];
  selectedAgent: number | null;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  agentFolders: Record<number, FleetAgentFolder | undefined>;
  characters: Record<number, FleetCharacterMetadata | undefined>;
  telemetry?: FleetTelemetryProjection;
}

export interface FleetRecentEvent {
  label: string;
  observedAt?: number;
  agentId?: number;
}

export interface FleetAgentModel {
  id: number;
  displayName?: string;
  createdAt?: number;
  role: FleetSceneRole;
  roleLabel: string;
  vesselLabel: string;
  status: string;
  runtime: FleetRuntime;
  runtimeLabel: string;
  repo: string;
  cwd: string;
  worktree: string;
  currentTool: string;
  executionLabel: string;
  currentTask: string;
  usage: string;
  usageCompact: string;
  inputTokens: string;
  cachedTokens: string;
  outputTokens: string;
  provider: string;
  model: string;
  session: string;
  terminalName: string;
  terminalAvailable: boolean;
  /** Terminal is alive, but no runtime/session event proves a first turn yet. */
  awaitingFirstInput: boolean;
  connection: 'connected' | 'connecting' | 'disconnected';
  connectionStack: FleetConnectionCheck[];
  context: string;
  managed: string;
  focusAgentId: number;
  commandAgentId: number;
  recentEvents: FleetRecentEvent[];
  attention: FleetAttention;
}

export type FleetAttentionKind =
  | 'none'
  | 'needs-permission'
  | 'needs-input'
  | 'waiting-unknown'
  | 'needs-startup-interaction'
  | 'error'
  | 'disconnected'
  | 'completion-unread';

export interface FleetAttention {
  kind: FleetAttentionKind;
  label: string;
  detail: string;
  action: 'none' | 'focus-terminal' | 'restart' | 'view-result';
  actionLabel: string;
}

export type FleetConnectionCheckState = 'connected' | 'connecting' | 'disconnected' | 'unavailable';

export interface FleetConnectionCheck {
  label: string;
  state: FleetConnectionCheckState;
  detail?: string;
}

export interface FleetRepoGroup {
  repo: string;
  agents: FleetAgentModel[];
}

export interface FleetResourceRow {
  label: string;
  value: string;
  detail?: string;
}

export interface FleetMissionModel {
  id: string;
  title: string;
  objective: string;
  status: 'active' | 'idle' | 'unavailable';
  coordinator: FleetAgentModel | null;
  completedTasks: number | null;
  totalTasks: number | null;
  openPullRequests: number | null;
  wallClock: string;
  agentTime: string;
  resources: FleetResourceRow[];
}

export interface FleetSceneModel {
  agents: FleetAgentModel[];
  groups: FleetRepoGroup[];
  selectedAgent: FleetAgentModel | null;
  mission: FleetMissionModel;
  recentEvents: FleetRecentEvent[];
  workingCount: number;
  waitingCount: number;
  attentionCount: number;
  telemetryEvents: FleetEvent[];
}

const ROLE_LABELS: Record<FleetSceneRole, string> = {
  coordinator: 'Coordinator',
  worker: 'Worker',
  reviewer: 'Reviewer',
  debugger: 'Debugger',
  subagent: 'Subagent',
  external: 'External',
};

const VESSEL_LABELS: Record<FleetSceneRole, string> = {
  coordinator: 'Flagship',
  worker: 'Frigate',
  reviewer: 'Recon Vessel',
  debugger: 'Debug Vessel',
  subagent: 'Drone',
  external: 'Unidentified Vessel',
};

const KNOWN_ROLES = new Set<FleetSceneRole>([
  'coordinator',
  'worker',
  'reviewer',
  'debugger',
  'subagent',
  'external',
]);

function snapshotForAgent(
  projection: FleetTelemetryProjection | undefined,
  id: number,
): FleetTelemetrySnapshot | undefined {
  return projection?.snapshots.find((snapshot) => snapshot.agentId === id);
}

function roleFromName(name: string | undefined): FleetSceneRole | undefined {
  const value = name?.toLowerCase();
  if (!value) return undefined;
  if (value.includes('review')) return 'reviewer';
  if (value.includes('debug')) return 'debugger';
  return 'worker';
}

function toRole(
  snapshot: FleetTelemetrySnapshot | undefined,
  character: FleetCharacterMetadata | undefined,
): FleetSceneRole {
  if (character?.isSubagent || snapshot?.role === 'subagent') return 'subagent';
  if (
    snapshot?.role &&
    snapshot.role !== 'worker' &&
    KNOWN_ROLES.has(snapshot.role as FleetSceneRole)
  ) {
    return snapshot.role as FleetSceneRole;
  }
  if (snapshot?.managedByFleet === false || character?.isHeadless) return 'external';
  if (character?.isTeamLead) return 'coordinator';
  return roleFromName(character?.agentName) ?? 'worker';
}

function normalizeStatus(status: string | undefined): string {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'working':
    case 'running':
    case 'active':
      return 'Working';
    case 'waiting':
      return 'Waiting';
    case 'idle':
      return 'Idle';
    case 'error':
      return 'Error';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Idle';
  }
}

function display(value: string | undefined): string {
  return value && value.length > 0 ? value : '—';
}

function tokenLabel(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString();
}

function compactTokenLabel(value: string): string {
  if (value === '—') return '未采集';
  const numeric = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(numeric)) return value;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}k`;
  return numeric.toLocaleString();
}

function usageLabels(character: FleetCharacterMetadata | undefined): {
  total: string;
  input: string;
  cached: string;
  output: string;
} {
  const usage = character?.usageTokens;
  if (!usage) return { total: '—', input: '—', cached: '—', output: '—' };
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0);
  return {
    total: tokenLabel(total),
    input: tokenLabel(usage.inputTokens),
    cached: tokenLabel(usage.cachedInputTokens),
    output: tokenLabel(usage.outputTokens),
  };
}

function connectionState(
  snapshot: FleetTelemetrySnapshot | undefined,
  status: string,
): FleetAgentModel['connection'] {
  if (status === 'Error' || status === 'Stopped') return 'disconnected';
  // A managed Claude terminal is a real connection boundary even before the
  // first prompt creates the native Session JSONL. CLI/Hook/Telemetry remain
  // independently visible as "connecting" in connectionStack until that
  // first runtime event arrives.
  if (snapshot?.terminalId || snapshot?.sessionId) return 'connected';
  return 'connecting';
}

/** Keep absolute paths in detail.cwd, but use a stable basename for scene grouping. */
function repoDisplayName(value: string | undefined): string {
  const displayed = display(value);
  if (displayed === '—') return displayed;
  const parts = displayed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? displayed;
}

function currentTool(
  snapshot: FleetTelemetrySnapshot | undefined,
  character: FleetCharacterMetadata | undefined,
  tools: ToolActivity[],
): string {
  const activeTool = [...tools].reverse().find((tool) => !tool.done);
  return display(snapshot?.currentTool ?? character?.currentTool ?? activeTool?.status);
}

function executionLabel(
  status: string,
  tool: string,
  awaitingFirstInput = false,
  bootstrapState?: NonNullable<FleetTelemetrySnapshot['bootstrap']>['state'],
): string {
  if (bootstrapState === 'needs_user_interaction') return '等待启动确认';
  if (awaitingFirstInput) return '等待首条消息';
  if (status === 'Starting') return '启动运行时';
  if (status === 'Waiting') return '等待交互';
  if (status === 'Error') return '运行错误';
  if (status === 'Stopped') return '已停止';
  if (status === 'Idle') return '空闲';
  if (tool === '—') return status === 'Working' ? '工作中' : status;
  const normalized = tool.toLowerCase();
  if (normalized.includes('mcp')) return '调用 MCP';
  if (
    normalized.includes('bash') ||
    normalized.includes('shell') ||
    normalized.includes('command')
  ) {
    return '执行命令';
  }
  if (
    normalized.includes('read') ||
    normalized.includes('grep') ||
    normalized.includes('glob') ||
    normalized.includes('file')
  ) {
    return '读取文件';
  }
  if (
    normalized.includes('web') ||
    normalized.includes('browser') ||
    normalized.includes('fetch')
  ) {
    return '浏览网页';
  }
  if (normalized.includes('task') || normalized.includes('agent')) return '多 Agent 协作';
  return '工作中';
}

function hasRuntimeActivity(snapshot: FleetTelemetrySnapshot | undefined): boolean {
  return (
    snapshot?.recentEvents.some(
      (event) => event.eventType !== 'agent_started' && event.eventType !== 'session_started',
    ) ?? false
  );
}

function isAwaitingFirstInput(
  snapshot: FleetTelemetrySnapshot | undefined,
  status: string,
  connection: FleetAgentModel['connection'],
): boolean {
  return status === 'Starting' && connection === 'connected' && !hasRuntimeActivity(snapshot);
}

function attentionFor(
  snapshot: FleetTelemetrySnapshot | undefined,
  status: string,
  tool: string,
  tools: ToolActivity[],
  character: FleetCharacterMetadata | undefined,
  connection: FleetAgentModel['connection'],
  awaitingFirstInput: boolean,
): FleetAttention {
  if (snapshot?.bootstrap?.state === 'needs_user_interaction') {
    return {
      kind: 'needs-startup-interaction',
      label: '等待启动确认',
      detail:
        snapshot.bootstrap.reason === 'workspace_trust'
          ? 'Claude 需要确认当前工作区'
          : '等待 Claude 启动交互',
      action: 'focus-terminal',
      actionLabel: '聚焦终端',
    };
  }
  const permission = tools.some((item) => !item.done && item.permissionWait);
  if (permission) {
    return {
      kind: 'needs-permission',
      label: '等待权限',
      detail: tool === '—' ? '运行时请求用户批准' : tool,
      action: 'focus-terminal',
      actionLabel: '查看请求',
    };
  }
  if (status === 'Waiting' && character?.waitingAwaitingInput) {
    return {
      kind: 'needs-input',
      label: '等待用户输入',
      detail: '运行时正在等待回复',
      action: 'focus-terminal',
      actionLabel: '回复',
    };
  }
  if (status === 'Error') {
    return {
      kind: 'error',
      label: 'CLI 错误',
      detail: '运行时报告错误或进程已退出',
      action: 'restart',
      actionLabel: '重新启动',
    };
  }
  if (connection === 'disconnected') {
    return {
      kind: 'disconnected',
      label: '连接断开',
      detail: '终端或 CLI 不可用',
      action: 'restart',
      actionLabel: '重新启动',
    };
  }
  if (awaitingFirstInput) {
    return {
      kind: 'needs-input',
      label: '等待用户输入',
      detail: '终端已启动，等待首条消息',
      action: 'focus-terminal',
      actionLabel: '回复',
    };
  }
  if (status === 'Waiting') {
    return {
      kind: 'waiting-unknown',
      label: '等待交互',
      detail: '等待类型未确定',
      action: 'focus-terminal',
      actionLabel: '打开终端',
    };
  }
  if (character?.completionUnread) {
    return {
      kind: 'completion-unread',
      label: '完成 · 未查看',
      detail: '任务已完成，结果尚未打开',
      action: 'view-result',
      actionLabel: '查看结果',
    };
  }
  return { kind: 'none', label: '', detail: '', action: 'none', actionLabel: '' };
}

function contextLabel(
  snapshot: FleetTelemetrySnapshot | undefined,
  character: FleetCharacterMetadata | undefined,
): string {
  const used = snapshot?.contextUsage?.usedTokens ?? character?.contextTokens;
  const limit = snapshot?.contextUsage?.limitTokens ?? character?.maxContextTokens;
  if (used === undefined || limit === undefined || limit <= 0) return '—';
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

function connectionStack(
  snapshot: FleetTelemetrySnapshot | undefined,
  status: string,
): FleetConnectionCheck[] {
  const runtime = snapshot?.runtime ?? 'claude-code';
  const terminalConnected = Boolean(snapshot?.terminalId || snapshot?.terminalName);
  const terminal: FleetConnectionCheck = terminalConnected
    ? { label: 'Terminal', state: 'connected', detail: snapshot?.terminalName }
    : runtime === 'codex-cli'
      ? { label: 'Terminal', state: 'unavailable', detail: '外部 Session' }
      : { label: 'Terminal', state: 'disconnected', detail: '没有注册终端' };
  const cli: FleetConnectionCheck =
    status === 'Error' || status === 'Stopped'
      ? { label: 'CLI', state: 'disconnected', detail: '进程已退出或已停止' }
      : status === 'Starting'
        ? snapshot?.bootstrap?.state === 'needs_user_interaction'
          ? { label: 'CLI', state: 'connected', detail: '进程已启动' }
          : { label: 'CLI', state: 'connecting', detail: '等待运行时事件' }
        : {
            label: 'CLI',
            state: 'connected',
            detail: runtime === 'codex-cli' ? 'Codex CLI' : 'Claude CLI',
          };
  const hasHookEvent =
    snapshot?.recentEvents.some((event) => event.source === 'claude-hook') ?? false;
  const hook: FleetConnectionCheck =
    runtime !== 'claude-code'
      ? { label: 'Hook', state: 'unavailable', detail: '该 Runtime 不使用 Claude Hook' }
      : hasHookEvent
        ? { label: 'Hook', state: 'connected', detail: '已收到 Hook 事件' }
        : status === 'Starting'
          ? { label: 'Hook', state: 'connecting', detail: '等待 SessionStart' }
          : { label: 'Hook', state: 'unavailable', detail: '尚未收到 Hook 事件' };
  const telemetry: FleetConnectionCheck = snapshot?.lastActivityAt
    ? { label: 'Telemetry', state: 'connected', detail: '最近事件已接收' }
    : { label: 'Telemetry', state: 'connecting', detail: '等待遥测数据' };
  return [terminal, cli, hook, telemetry];
}

function recentEvents(
  snapshot: FleetTelemetrySnapshot | undefined,
  status: string,
  tool: string,
): FleetRecentEvent[] {
  if (snapshot?.recentEvents.length) {
    return snapshot.recentEvents
      .slice(-4)
      .reverse()
      .map((event) => ({
        label: event.eventType.replaceAll('_', ' '),
        observedAt: event.observedAt,
        agentId: event.agentId,
      }));
  }
  const events: FleetRecentEvent[] = [{ label: status }];
  if (tool !== '—') events.unshift({ label: `tool: ${tool}` });
  return events;
}

function toAgentModel(input: FleetSceneInput, id: number): FleetAgentModel {
  const snapshot = snapshotForAgent(input.telemetry, id);
  const character = input.characters[id];
  const folder = input.agentFolders[id];
  const role = toRole(snapshot, character);
  const status = normalizeStatus(snapshot?.status ?? input.agentStatuses[id]);
  const tool = currentTool(snapshot, character, input.agentTools[id] ?? []);
  const commandAgentId = character?.parentAgentId ?? id;
  const usage = usageLabels(character);
  const connections = connectionStack(snapshot, status);
  const connection = connectionState(snapshot, status);
  const awaitingFirstInput = isAwaitingFirstInput(snapshot, status, connection);
  const attention = attentionFor(
    snapshot,
    status,
    tool,
    input.agentTools[id] ?? [],
    character,
    connection,
    awaitingFirstInput,
  );

  return {
    id,
    displayName: character?.displayName ?? character?.agentName ?? snapshot?.displayName,
    createdAt: character?.createdAt,
    role,
    roleLabel: ROLE_LABELS[role],
    vesselLabel: VESSEL_LABELS[role],
    status,
    runtime: snapshot?.runtime ?? 'claude-code',
    runtimeLabel: snapshot?.runtime === 'codex-cli' ? 'Codex CLI' : 'Claude Code',
    repo: repoDisplayName(snapshot?.repo ?? folder?.name),
    cwd: display(snapshot?.cwd ?? folder?.path),
    worktree: '—',
    currentTool: tool,
    executionLabel: executionLabel(status, tool, awaitingFirstInput, snapshot?.bootstrap?.state),
    currentTask: display(snapshot?.currentTask),
    usage: usage.total,
    usageCompact: compactTokenLabel(usage.total),
    inputTokens: usage.input,
    cachedTokens: usage.cached,
    outputTokens: usage.output,
    provider: display(snapshot?.providerDisplayName),
    model: display(snapshot?.modelId),
    session: display(snapshot?.sessionId),
    terminalName: display(snapshot?.terminalName),
    terminalAvailable: Boolean(snapshot?.terminalId),
    awaitingFirstInput,
    connection,
    connectionStack: connections,
    context: contextLabel(snapshot, character),
    managed: snapshot?.managedByFleet === false || character?.isHeadless ? 'External' : 'Fleet',
    focusAgentId: commandAgentId,
    commandAgentId,
    recentEvents: recentEvents(snapshot, status, tool),
    attention,
  };
}

export function buildFleetSceneModel(input: FleetSceneInput): FleetSceneModel {
  const agents = [...new Set(input.agents)]
    .sort((a, b) => a - b)
    .map((id) => toAgentModel(input, id));
  const groupsByRepo = new Map<string, FleetAgentModel[]>();
  for (const agent of agents) {
    const group = groupsByRepo.get(agent.repo) ?? [];
    group.push(agent);
    groupsByRepo.set(agent.repo, group);
  }
  const groups = [...groupsByRepo.entries()].map(([repo, group]) => ({ repo, agents: group }));
  const selectedAgent =
    agents.find((agent) => agent.id === input.selectedAgent) ?? agents[0] ?? null;
  const snapshots = input.telemetry?.snapshots ?? [];
  const fleetIdentity = snapshots.find((snapshot) => snapshot.fleet)?.fleet;
  const missionId = fleetIdentity?.fleetRunId;
  const taskId = fleetIdentity?.fleetTaskId;
  const coordinator = agents.find((agent) => agent.role === 'coordinator') ?? null;
  const resources = [
    ...new Set(agents.map((agent) => agent.provider).filter((value) => value !== '—')),
  ].map((provider) => ({
    label: provider,
    value: `${agents.filter((agent) => agent.provider === provider).length} instance(s)`,
    detail: 'Quota unavailable',
  }));
  const recentEvents = (input.telemetry?.recentEvents ?? [])
    .slice(-8)
    .reverse()
    .map((event) => ({
      label: event.eventType.replaceAll('_', ' '),
      observedAt: event.observedAt,
      agentId: event.agentId,
    }));

  return {
    agents,
    groups,
    selectedAgent,
    mission: {
      id: missionId ?? '—',
      title: missionId ? `Fleet run ${missionId}` : 'No active mission',
      objective: taskId ? `Task ${taskId}` : 'Awaiting mission context',
      status: missionId ? (agents.length > 0 ? 'active' : 'idle') : 'unavailable',
      coordinator,
      completedTasks: null,
      totalTasks: null,
      openPullRequests: null,
      wallClock: '—',
      agentTime: '—',
      resources,
    },
    recentEvents,
    workingCount: agents.filter((agent) => agent.status === 'Working').length,
    waitingCount: agents.filter((agent) => agent.status === 'Waiting').length,
    attentionCount: agents.filter((agent) => agent.attention.kind !== 'none').length,
    telemetryEvents: [...(input.telemetry?.recentEvents ?? [])],
  };
}

export function isFleetRole(value: AgentRole | undefined): value is FleetSceneRole {
  return value !== undefined && KNOWN_ROLES.has(value as FleetSceneRole);
}
