# Coordinator ↔ Claude Fleet 协作工作流

> 这是 Claude Fleet v0.2 的目标工作流。它定义 Codex Coordinator、Fleet
> Controller、Claude Fleet UI、Codex/Claude Worker 和 agentmetrics 之间的边界。
> 当前版本的本地 Control HTTP API 已可用于协调和验收；`fleet.*` MCP 是其后续
> 适配层，不是另一份状态源。

## 1. 角色分工

```text
Codex Coordinator
  负责：理解目标、拆 Plan、分配 Task、Review、Merge Proposal

Fleet Controller
  负责：唯一状态源、创建/停止 Worker、Worktree、Session、预算、事件

Claude Fleet / VS Code
  负责：执行现场、Terminal、Diff、人工接管、状态投影

Codex / Claude Worker
  负责：在自己的 Worktree 中执行具体 Task

agentmetrics
  负责：Token、时间、成本、Quota 证据和结果归档
```

Codex 不直接拥有 Claude 进程。所有 Worker 的生命周期变更都经过 Controller。
VS Code 和 Codex 都是 Controller 状态的 Projection。

当前可用的本地边界包括：

- `POST /api/control`：创建/启动、停止、重启、恢复、Focus、投递 WorkItem、记录质量信号；
- `GET /api/control/instances`：读取当前 Fleet 实例；
- `GET /api/control/metrics?instanceId=&workItemId=`：读取 token、耗时以及同币种/同计费基础的费用汇总；
- `GET /api/control/quality?workItemId=`：读取与 WorkItem 关联的质量/PR 信号。
- `POST /api/control/telemetry`：接收 agentmetrics 或运行时产生的有界 Usage/Quota
  信号，使用 `idempotencyKey` 去重；
- `GET /api/coordinator/session`、`GET /api/coordinator/plan`、
  `POST /api/coordinator/tick`：访问 VS Code 内置的主 Coordinator session。

这些端点要求本地 Control token。真实 Provider 的账号额度或未提供结构化计量时，
Usage 必须显示 `NOT_AVAILABLE`，不能用估算值冒充真实 token 或费用。
Codex 的本地 JSONL 可以提供累计 token 和最近一轮耗时；账户级套餐剩余额度仍然只能
作为独立 quota 快照，无法在并发 Agent 间证明归属时保持 `unavailable`。

VS Code 扩展会把 Ledger 持久化到其 global storage 的 `fleet-ledger.json`，因此刷新
Webview 不会重置协调记录；只有损坏快照才会 fail-closed 回退到当前会话内存 Ledger
并在 Extension Host 日志中报告。

## 2. 一次任务的完整生命周期

```text
用户目标
  ↓
Coordinator Plan
  ↓
Task DAG
  ↓
Controller 创建 WorkerInstance / WorktreeLease
  ↓
Codex / Claude Worker 执行
  ↓
事件、Diff、测试、UsageRecord
  ↓
Evaluator 评估
  ↓
重试 / 转派 / 降级 / 升级
  ↓
Merge Proposal
  ↓
Codex Review + 用户确认
```

一个 Task 可以有多个并行 Worker，但每个 Worker 必须拥有独立 Worktree；第一版
不允许多个 Worker 同时写同一个目录。

## 3. Coordinator 发起任务

Coordinator 先向 Fleet 请求创建任务，而不是直接执行 shell：

```text
fleet.create_run({
  goal,
  repository,
  coordinator_id,
  budget: {
    max_concurrency,
    max_tokens,
    deadline
  }
})
```

Controller 返回 `fleet_run_id`。随后 Coordinator 把目标拆成有依赖关系的 Task：

```text
fleet.create_task({
  fleet_run_id,
  task_id,
  title,
  task_type: "implementation | test | review | investigate | docs",
  depends_on: [],
  complexity: "low | medium | high | critical",
  write_policy: "worktree | read_only",
  acceptance_criteria
})
```

## 4. Coordinator 调用 Claude Fleet

```text
fleet.spawn_worker({
  fleet_run_id,
  task_id,
  agent_type: "CLAUDE",
  provider: "MiniMax",
  model: "minimaxm3",
  role: "implementation",
  worktree_policy: "isolated",
  permission_mode: "worker",
  budget: {
    max_tokens,
    max_turns,
    timeout_seconds
  }
})
```

Controller 负责生成并返回：

```text
worker_id
fleet_run_id
fleet_task_id
worktree_id
worktree_path
branch
agent_session_id（创建后绑定）
metrics_run_id
```

Worker prompt 只包含 Task、约束和验收标准，不包含 Controller 私有 secret。身份
字段通过参数或环境传递给 agentmetrics，不通过 prompt 猜测。

## 5. 允许的控制操作

```text
fleet.get_status(run_id / task_id / worker_id)
fleet.send_message(worker_id, message)
fleet.pause_worker(worker_id)
fleet.resume_worker(worker_id)
fleet.stop_worker(worker_id)
fleet.attach_worker(worker_id)
fleet.collect_result(worker_id)
fleet.get_usage(worker_id / task_id / run_id)
```

上述目标操作在本地 HTTP API 中对应 `submit`、`getInstance`、`listInstances`、
`getMetrics` 和 `getQuality`；`FleetControlClient` 负责请求封装和响应校验。

`attach_worker` 表示人工接管；人工操作仍然通过 Controller 记录状态。Codex 不
应通过屏幕抓取或模拟键盘控制 Claude TUI。

## 6. Worker 返回结果

Worker 返回的是结构化结果，不是只返回一句“完成了”：

```json
{
  "worker_id": "worker-17",
  "task_id": "task-backend",
  "status": "COMPLETED",
  "changed_files": ["src/auth.ts"],
  "tests": [{ "command": "npm test -- auth", "status": "PASSED" }],
  "commit": null,
  "blockers": [],
  "result_summary": "...",
  "metrics_run_id": "..."
}
```

不得把 prompt、完整 response、源码内容或 secret 写入 `WorkerResult` 或
`sanitized-summary.json`。

## 7. agentmetrics 关联规则

每个执行段都带以下身份：

```text
fleet_run_id
fleet_task_id
fleet_worker_id
fleet_coordinator_id
parent_worker_id
worker_role
worktree_id
attempt
```

Usage 关联顺序：

```text
Fleet identity
→ native Codex thread / Claude session + cursor
→ process
→ worktree
→ time window
```

无法证明唯一归属时，显示 `AMBIGUOUS`，不猜 Token、不把账户 Quota 分摊给某个
Worker。

## 8. 动态调度与额度控制

初始并发由 Controller 根据预算决定。运行中根据事件调整：

```text
额度紧张       → 降低并发 / 使用低成本 Provider
任务连续失败   → 升级到高推理 Codex / 增加 Review
结果提前满足   → 取消冗余 Worker
关键路径阻塞   → 提高 Task 优先级
低风险批量任务 → 派给 MiniMax / DeepSeek Worker
```

Agent 评分按任务类型记录，不使用永久总分：

```text
correctness
test_pass_rate
review_defect_rate
duration
token_cost
rework_rate
confidence
```

只有测试、Diff Review 和实际结果都完成后，才更新 Agent capability profile。

## 9. Merge Gate

第一版默认不自动合并：

```text
Worker 完成
  → 测试通过
  → Diff Review
  → 冲突检查
  → Usage / 失败证据完整
  → Codex 生成 Merge Proposal
  → 用户确认
```

低风险任务未来可以配置自动合并，但必须经过同一套 Gate，不能只依据 Worker 自报
“完成”。

## 10. 故障与恢复

- Coordinator 崩溃：Controller 保留 Worker 状态，恢复后按 `fleet_run_id` 继续。
- Worker 崩溃：关闭 metrics run，记录失败原因，再决定重试、转派或升级。
- Session 关联不唯一：Usage 标记 `AMBIGUOUS`，不阻塞任务结果收集。
- Python / agentmetrics 不可用：Worker 可以继续运行，但 Usage 显示
  `NOT_AVAILABLE`，不得伪造数据。
- 用户主动接管：Worker 状态切换为 `HUMAN_ATTACHED`，Scheduler 暂停自动重试。
