# Workflow — Coordinator / Fleet Collaboration

> 适用于 Codex 作为 Coordinator、Claude Fleet 作为本地执行控制面的协作任务。
> 这是工具中立的运行流程；`fleet.*` 表示 Controller 的 MCP / Local API Contract。

## 进入条件

- 用户目标已经明确；
- 仓库、基线分支和 Worktree 策略已确定；
- Coordinator 知道哪些工作必须自己完成，哪些可以交给 Worker。

## Coordinator 保留的工作

- 产品边界和验收标准；
- Schema / API / 安全 / 额度语义；
- 跨模块集成；
- 最终 Review、Merge Proposal 和用户确认；
- Worker 失败分类与重新分配。

## 可派发给 Worker 的工作

- 局部实现；
- focused tests；
- 文档和 fixture；
- read-only audit；
- 独立的替代方案探索。

高风险、跨模块或语义不明确的任务不直接派给弱模型。

## 标准步骤

1. 创建 `FleetRun` 和 Task DAG。
2. 为每个可并行 Task 请求独立 Worktree。
3. 通过 `fleet.spawn_worker` 启动 Codex/Claude Worker。
4. 将 `fleet_*` identity 和预算传入 runner。
5. 监听 `WorkerStarted`、`WorkerProgress`、`WorkerWaiting`、`WorkerFinished`、
   `WorkerFailed` 和 `UsageUpdated`。
6. 收集 WorkerResult、测试结果、Diff 和 agentmetrics summary。
7. 根据证据决定重试、转派、升级、取消或进入 Review。
8. 生成 Merge Proposal；未经批准不修改主分支。
9. 更新 capability profile 和任务级指标。

## 禁止事项

- Coordinator 直接在 Worker Worktree 外修改 Worker 文件；
- 多个可写 Worker 共享同一 Worktree；
- 使用 PID、Terminal 名称或“最新 transcript”猜测归属；
- 把 Quota 百分比换算成 Session Token；
- 把模型自报的完成度当成总进度；
- 让 Plan Mode 文案代替 Controller 的权限策略。

## 结束条件

一次协作只有在以下信息都可追溯时才算完成：

```text
FleetRun
Task
Worker
Worktree
Native Session
UsageRecord
WorkerResult
Review / Merge decision
```
