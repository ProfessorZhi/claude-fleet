import type { ToolActivity } from '../types.js';

export const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

/** Add a stable category without hiding the provider-specific live status. */
export function formatToolActivity(toolName?: string, status?: string): string {
  if (!toolName) return status ?? 'Working';
  const name = toolName.toLowerCase();
  const detail = status ?? toolName;
  if (name === 'thinking' || name.includes('reason')) return '推理中';
  if (name === 'task' || name === 'agent' || name.includes('subagent') || name.includes('spawn')) {
    return `多 Agent · ${detail}`;
  }
  if (name === 'taskcreate' || name === 'tasklist' || name === 'taskupdate') {
    return `任务管理 · ${detail}`;
  }
  if (
    name === 'bash' ||
    name.includes('shell') ||
    name.includes('command') ||
    name.includes('exec')
  ) {
    return `命令行 · ${detail}`;
  }
  if (name.includes('web') || name.includes('browser') || name.includes('search')) {
    return `查阅网页 · ${detail}`;
  }
  if (name.includes('mcp') || name.includes('server')) return `MCP · ${detail}`;
  if (name.includes('plugin')) return `插件 · ${detail}`;
  if (
    name === 'read' ||
    name === 'edit' ||
    name === 'write' ||
    name === 'grep' ||
    name === 'glob'
  ) {
    return `文件操作 · ${detail}`;
  }
  return detail;
}

/** Convert the extension's canonical status into a compact scene label. */
export function formatAgentStatusLabel(status?: string): string | undefined {
  if (!status) return undefined;
  const labels: Record<string, string> = {
    starting: 'Starting',
    working: 'Working',
    active: 'Working',
    waiting: 'Waiting',
    idle: 'Idle',
    error: 'Error',
    stopped: 'Stopped',
  };
  return labels[status.toLowerCase()] ?? status;
}

/** Derive a short human-readable activity string from tools/status. */
export function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
  agentStatus?: string,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return formatToolActivity(activeTool.toolName, activeTool.status);
    }
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return formatToolActivity(lastTool.toolName, lastTool.status);
    }
  }

  return formatAgentStatusLabel(agentStatus) ?? 'Idle';
}
