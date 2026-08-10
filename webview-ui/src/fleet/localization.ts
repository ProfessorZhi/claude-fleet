import type { FleetSceneRole } from './model.js';

const STATUS_LABELS: Record<string, string> = {
  Starting: '启动中',
  Working: '工作中',
  Waiting: '等待中',
  Idle: '空闲',
  Error: '错误',
  Stopped: '已停止',
};

const ROLE_LABELS: Record<FleetSceneRole, string> = {
  coordinator: '主控',
  worker: '工作 Agent',
  reviewer: '审查 Agent',
  debugger: '调试 Agent',
  subagent: '子 Agent',
  external: '外部 Agent',
};

const VESSEL_LABELS: Record<FleetSceneRole, string> = {
  coordinator: '旗舰',
  worker: '护卫舰',
  reviewer: '侦察舰',
  debugger: '工程舰',
  subagent: '无人机',
  external: '未知舰船',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function roleLabel(role: FleetSceneRole): string {
  return ROLE_LABELS[role];
}

export function vesselLabel(role: FleetSceneRole): string {
  return VESSEL_LABELS[role];
}
