# 007-fleet-observability-workflow — Design

## 高层形态

```text
Claude Hooks ─┐
Claude JSONL ─┤
AgentState ────┼→ Normalizer → FleetEvent → FleetTelemetryStore → Projection
agentmetrics ─┤                                  ├→ VS Code Scene/UI
Future Codex ─┘                                  └→ external management view
```

## FleetEvent

```ts
interface FleetEvent {
  eventId: string;
  eventType: FleetEventType;
  observedAt: number;
  source: FleetEventSource;
  instanceId?: string;
  agentId?: number;
  runtime?: 'claude-code' | 'codex' | 'other';
  managedByFleet?: boolean;
  repo?: string;
  cwd?: string;
  sessionId?: string;
  providerProfileId?: string;
  providerDisplayName?: string;
  modelId?: string;
  fleet?: FleetIdentity;
  status?: string;
  currentTool?: string;
  contextUsage?: { usedTokens?: number; limitTokens?: number };
  error?: { message: string; timestamp: number; source: string };
}
```

当前实现见 `core/src/fleetTelemetry.ts`。事件历史最多保留 50 条；Snapshot 是内存投影，
不保存原始 transcript。当前 Agent 的 runtime 固定为 `claude-code`，role 固定为 `worker`；
外部 Codex Client 不进入 FleetTelemetryStore。

## Ownership

- Normalizer 负责格式转换；
- `FleetTelemetryStore` 负责幂等、有界历史和 Snapshot 状态合并；
- Projection 负责展示，不修改事实；
- agentmetrics 负责 UsageRecord 的证据完整性。

## 失败模式

| 情况             | 行为                                                |
| ---------------- | --------------------------------------------------- |
| 原始事件格式变化 | Normalizer 忽略未知字段，不猜状态                   |
| event_id 重复    | Controller 幂等丢弃                                 |
| 关联键缺失       | 保留事件但标记 `UNASSOCIATED`                       |
| Usage 只有 Quota | 显示 `QUOTA_ONLY`，不转换成 Token                   |
| 事件顺序乱序     | 按 observedAt 展示，按 Controller sequence 更新状态 |
