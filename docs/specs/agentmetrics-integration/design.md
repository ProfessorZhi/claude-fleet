# 007-agentmetrics-integration — Design

> Context：[requirements.md](./requirements.md)  
> 相关架构：[ARCHITECTURE.md](../../ARCHITECTURE.md)

## 高层形态

```text
Claude Fleet 主仓库
│
├── TypeScript Control Plane / VS Code Adapter
│   ├── FleetRun / Task / Worker identity
│   └── Agent runtime state
│
├── agentmetrics/
│   ├── Python Usage Ledger
│   ├── Codex / Claude collectors
│   ├── quota adapters
│   ├── pricing / PR aggregate
│   └── PowerShell runners
│
└── shared contract
    ├── fleet-run-context.schema.json
    └── sanitized-summary extension fields
```

## 核心决策

### D1. 合并目录

将原仓库的产品内容放在主仓库顶层 `agentmetrics/`，保持其内部结构：

```text
agentmetrics/
├── config/
├── docs/
├── schemas/
├── scripts/
├── src/
├── tests/
├── agent-metrics.ps1
├── pyproject.toml
└── README.md
```

不把它拆散到 `server/` 或 `core/`，因为 Python collector 仍然需要独立运行、测试
和发布；“单仓库”不等于“单语言模块”。

### D2. Identity 合同

Fleet identity 是业务关联键，不替代 Agent 原生身份：

```text
FleetRun
├── fleet_run_id       一次可审计的 Worker 执行段
├── fleet_task_id      任务 DAG 节点
├── fleet_worker_id    Fleet 中的 Worker 实例
├── fleet_coordinator_id
├── parent_worker_id
├── worker_role
├── worktree_id
└── attempt

Native identity
├── agent_session_id   Codex thread / Claude session
├── process_id
└── terminal_id
```

Python run context 使用 snake_case；TypeScript 内部类型使用 camelCase；JSON 边界
统一使用 snake_case，避免跨语言序列化歧义。

### D3. 关联与失败安全

Collector 先使用 Fleet identity 过滤候选，再使用 native session/cursor 做 usage
证明。Fleet identity 只能帮助定位，不能伪造 token usage。候选不唯一时保留
`AMBIGUOUS`。

### D4. CLI 扩展方式

现有 CLI 命令不改语义，只增加可选参数：

```text
--fleet-run-id
--fleet-task-id
--fleet-worker-id
--fleet-coordinator-id
--parent-worker-id
--worker-role
--worktree-id
--attempt
```

PowerShell runner 接受同名参数，并将它们传给 `agent-metrics start`。同时支持
`FLEET_*` 环境变量，便于 Claude Fleet Controller 调用而不把身份字段写入 prompt。

### D5. Summary 扩展

在 sanitized summary 顶层增加可选 `fleet` 对象：

```json
{
  "fleet": {
    "fleet_run_id": "run-...",
    "fleet_task_id": "task-...",
    "fleet_worker_id": "worker-...",
    "fleet_coordinator_id": "coord-...",
    "parent_worker_id": null,
    "worker_role": "tester",
    "worktree_id": "wt-...",
    "attempt": 1
  }
}
```

缺省时不写入 `fleet` 或写入空对象，具体以兼容旧 schema 的实现为准；不得覆盖
已有 `session`、`usage`、`quota` 的含义。

## 模块职责

| 模块                                       | 职责                                                |
| ------------------------------------------ | --------------------------------------------------- |
| `core/src/fleetContracts.ts`               | Claude Fleet 内部 Fleet identity 类型与校验         |
| `agentmetrics/src/agent_metrics/models.py` | Python run context / summary 数据模型               |
| `agentmetrics/src/agent_metrics/cli.py`    | 接收、持久化和输出 identity                         |
| `agentmetrics/schemas/`                    | Python 侧 schema 与兼容校验                         |
| `agentmetrics/scripts/`                    | Codex / Claude runner 参数透传                      |
| `adapters/vscode/`                         | 后续把 Worker launch intent 传给 Controller/metrics |

## 状态与数据流

```text
Controller creates Worker identity
        │
        ├── launch config / env / runner args
        ▼
agent-metrics start
        │  run_context + fleet identity
        ▼
native Codex / Claude process
        │  structured JSONL / transcript
        ▼
agent-metrics finish
        │  usage + timing + quota evidence
        ▼
sanitized-summary.json
        │
        ▼
Fleet Result / Usage projection
```

## 失败模式（Failure Modes）

| 场景                  | 行为                                                               |
| --------------------- | ------------------------------------------------------------------ |
| 没有 Fleet identity   | 按旧逻辑运行，summary 仍然有效                                     |
| identity 格式非法     | `start` 返回 invalid input，不启动 Worker                          |
| native session 不唯一 | usage 标记 `AMBIGUOUS`，不猜测                                     |
| quota 数据不可用      | 保留 `NOT_AVAILABLE`，不阻塞普通运行                               |
| Python 不可用         | Claude Fleet TypeScript 核心仍可启动；metrics 能力显示 unavailable |
| 迁移文件复制失败      | 保留原 metrics 仓库，主仓库不写入半成品                            |

## 取舍（Trade-offs）

- **顶层 `agentmetrics/` 而不是重写/拆散**：最大化复用现有测试和 CLI，代价是仓库
  同时包含 TypeScript 与 Python。
- **可选 identity**：保证旧脚本兼容，代价是旧运行仍可能只有 worktree/time-window
  关联。
- **单一 JSON 边界**：避免 TypeScript 与 Python 共享运行时依赖，代价是需要维护
  schema 与两侧类型。
- **不立即保留 Git 历史**：先保证功能合并和测试可回滚；若需要，再用 clean
  worktree 执行 subtree/history import，避免污染当前未提交改动。
