# 007-agentmetrics-integration — Requirements

> Feature slug：`007-agentmetrics-integration`  
> 目标：将 `agent-metrics-collector` 合并进 Claude Fleet 主仓库，并使它成为
> Coordinator / Worker 工作流的统一 Usage Ledger。

## 目标（Goal）

Claude Fleet 成为唯一产品仓库和控制平面的宿主；Codex、Claude Code 及其他
Worker 的运行记录、Session 关联、Token、时间、成本和额度证据都能被同一套
`FleetRun` 关联，而不破坏现有 Python CLI 的独立可运行能力。

## 用户故事（User Stories）

- 作为 Coordinator，我可以为每个 Worker 传入 `fleet_run_id`、`task_id`、
  `worker_id` 和 `parent_worker_id`，并在完成后按任务汇总 Usage。
- 作为开发者，我可以在 Claude Fleet 主仓库中运行原 metrics CLI 和现有测试。
- 作为开发者，我可以同时看到 Agent 原生 Session、Fleet Worker 身份和 metrics
  run 身份，而不需要通过 PID 或时间窗口猜测关联关系。
- 作为审计者，我可以区分 request usage、account quota、API-equivalent cost
  和 actual billed cost。
- 作为旧用户，我原来使用的 `agent-metrics` CLI、Python import 和 `.local/runs`
  数据格式仍然可用。

## 功能性需求（Functional Requirements）

### FR-001 单仓库合并

- Claude Fleet 根目录和主 GitHub 仓库名称保持不变。
- 原 `agent-metrics-collector` 的源码、测试、schema、配置、脚本和文档合入
  主仓库顶层 `agentmetrics/`。
- 不合入 `.git/`、`.local/` 运行数据、`__pycache__`、`*.egg-info`、临时输出、
  worktrees 和 smoke target。
- Python 包名保持 `agent_metrics`，CLI 命令保持 `agent-metrics`。

### FR-002 Fleet identity contract

每个 metrics run 的 run context 和 sanitized summary 支持以下可选、非秘密字段：

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

缺少这些字段时，旧 CLI 行为不变；存在时，字段原样关联到 summary 和聚合结果。

### FR-003 精确关联优先

关联优先级必须是：

```text
fleet_worker_id / fleet_run_id
→ native session id + cursor
→ process id
→ worktree
→ work package
→ time window
```

无法证明唯一归属时必须返回 `AMBIGUOUS`，不得选择“最新文件”或平均分摊。

### FR-004 Usage Ledger 语义

- Request token usage 来自 Codex JSONL、Claude JSONL 或其他明确的结构化来源。
- Quota / balance 只作为账户级证据，不转换成 session token。
- API-equivalent cost 与 actual billed cost 分开保存。
- 每条 UsageRecord 必须包含 source、collection status 和 correlation confidence。

### FR-005 兼容旧工作流

- 现有 `agent-metrics start/finish/reconcile/export/pr-summary` 命令继续可用。
- 现有 PowerShell runner 继续可用，只增加可选 Fleet identity 参数或环境变量。
- 现有 metrics 测试全部迁移后继续通过。

## 非功能性需求（Non-Functional Requirements）

- 不记录 prompt、response、源码、secret、token、邮箱或完整用户路径。
- Claude Fleet TypeScript 构建不依赖 Python runtime 才能通过类型检查。
- Metrics Python 测试可以在 `agentmetrics/` 内独立执行。
- 合并是可回滚的：旧 metrics 仓库在迁移验证完成前保留为只读迁移源。
- Fleet identity 字段向后兼容，未提供时不得改变旧 summary 的含义。

## 不在范围内（Out of Scope）

- 本 Spec 不实现完整 MCP Server。
- 本 Spec 不实现动态 Scheduler、Agent 评分或自动 Merge Gate。
- 本 Spec 不重写 Python collector 为 TypeScript。
- 本 Spec 不改变 VS Code command id、npm package name、Python import name 或
  `~/.claude-fleet` 状态目录。
- 本 Spec 不把 worktrees、smoke target、缓存和运行结果迁入产品仓库。

## 开放问题（Open Questions）

- 后续 Controller 是否使用 SQLite 作为持久化层，暂不由本 Spec 决定。
- 旧 metrics GitHub 仓库在合并后是 archive 还是继续作为独立发布源，待迁移验证后决定。
