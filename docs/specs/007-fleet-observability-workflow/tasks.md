# 007-fleet-observability-workflow — Tasks

- [x] T001 定义 FleetEvent 类型、Snapshot 和安全 identity 边界。
- [x] T002 将现有 AgentState/webview broadcast 规范化为最小 FleetEvent。
- [x] T003 建立有界的 `FleetTelemetryStore`，保留 50 条 recent events。
- [ ] T004 将 agentmetrics RUN_STARTED / RUN_FINISHED / UsageRecord 映射为 FleetEvent。
- [ ] T005 为事件去重、缺失关联、乱序和 Secret exclusion 增加测试。
- [x] T006 更新当前 Codex Client + Claude Code Worker 拓扑文档；Codex runtime 仅留 extension point。
