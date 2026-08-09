# 007-fleet-observability-workflow — Requirements

## 目标

建立 Agent-neutral 的 `FleetEvent` 遥测层，并正式记录当前唯一受支持的拓扑：外部
Codex Client 作为主线程/协调者，Claude Fleet 在 VS Code Terminal 中管理多个原生
Claude Code CLI Worker。

## 功能需求

- 支持当前真实信号可推出的 `agent_started`、`agent_stopped`、`working`、`waiting`、
  `idle`、`error`、`tool_started`、`tool_finished`、`subagent_started`、
  `subagent_finished`、`context_updated` 等事件；未来事件只文档化，不虚构。
- 每个事件必须带 `event_id`、`observed_at`、`source` 和至少一个 Fleet/native 关联键。
- 原始 Provider payload 只在 collector 内部解析，不直接暴露给 Webview。
- 事件不能包含 prompt、完整 response、源码、secret 或完整用户路径。
- 同一个事件重复到达时，Controller 能按 `event_id` 幂等处理。
- agentmetrics summary 继续作为可验证的 UsageRecord，不被 UI 自己重新推算。
- 每个当前 Claude Code Agent 至少提供 runtime、managed、repo/cwd、session、provider、
  model、status、context、lastActivity 和 error（无法获取时为 unavailable）。

## 非功能需求

- 事件源不可用时，Agent Runtime 仍可运行，状态标记为 `NOT_AVAILABLE`。
- 事件规范不绑定 Claude Code 或 Codex 字段名。
- UI 只消费规范化 FleetEvent / Telemetry Snapshot，不理解 Claude 原始 Hook/JSONL。

## 不在范围内

- OpenTelemetry exporter；
- 云端 telemetry；
- 完整 Trace Viewer；
- Codex Terminal runtime、通用 Coordinator、Agent Chat Bus、自动评分和 Scheduler。
