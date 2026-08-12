# Task Control Center Closure Design

## Data flow

```text
OfficeState / agentStatus / tool telemetry
                ↓
        FleetSceneModel
                ↓
 Task Control Center projection
```

`FleetAgentModel.attention` 是由现有状态和遥测信号派生的投影，不新增第二套持久化状态。

## Attention precedence

同一 Agent 同时出现多个信号时按以下顺序选择用户最需要处理的事项：

1. 未完成的权限请求
2. 明确等待用户输入
3. CLI 错误
4. 运行时断开
5. 完成未查看
6. 等待但无法分类
7. 无注意事项

等待输入/权限的判定只使用已有 `waitingAwaitingInput` 和 `ToolActivity.permissionWait` 信号。缺少信号时统一映射为 `waiting-unknown`。

## Layout

- Header：产品名、Mission 摘要、Agent 计数和低饱和 Primary 新建按钮。
- Mission Strip：56–88px 高，展示当前任务和紧凑指标。
- Workspace：左侧 Agent 列表，右侧 400–440px Inspector；左侧列表独立滚动。
- Inspector：Header、Current Work、Connection、Usage、Session 五个 section。
- Activity：底部紧凑事件条，避免和 Agent 列表争夺主空间。

## Action behavior

- `focus-terminal` 复用现有 Focus Agent 命令，不直接操作系统窗口。
- `restart` 复用现有 Restart Agent 命令。
- `view-result` 调用 `OfficeState.markCompletionViewed` 并选中 Agent；它不伪造 PR 或结果内容。
