# CODEX.md — Codex 适配层

本文件只描述 Codex 在 Claude Fleet 中的角色。通用规则以 `AGENTS.md` 和 `.agent/`
为准；产品架构以 `docs/` 为准。

## Codex 的默认角色

Codex 通常是 Coordinator / Architect / Reviewer：

- 理解用户目标并维护 Plan；
- 把任务拆成 Task DAG；
- 通过 Fleet Controller / MCP 调度 Codex 或 Claude Worker；
- 审核 Diff、测试、Usage 和失败原因；
- 生成 Merge Proposal，最终合并由 Codex + 用户控制。

Codex 不直接拥有 Claude Code 进程，也不通过屏幕抓取模拟终端操作。

## 开始任务前

依次阅读：

1. `AGENTS.md`
2. `docs/PROJECT.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`
5. 相关 `docs/specs/<feature>/`
6. `docs/COORDINATOR_WORKFLOW.md`
7. `.agent/workflows/coordinator-fleet-collaboration.md`

## Worker 调度约束

- 每个可写 Worker 使用独立 Worktree。
- 每个 Worker 必须有 `fleet_run_id`、`fleet_task_id`、`fleet_worker_id`。
- 不把 Prompt、完整 Response、Secret 或源码塞进 Usage / Handoff。
- Plan Mode 是交互语义，不是安全边界；权限由 Controller Policy 保证。
- 复杂架构、安全、Schema、跨模块集成和最终 Review 默认留在 Coordinator。

## 当前接口状态

当前版本已经提供认证的本地 Fleet Control HTTP API，以及对应的 TypeScript
`FleetControlClient`。Coordinator 可以通过它查询实例、投递控制动作、读取按
Agent/WorkItem 聚合的 token、时间和兼容费用，并记录/查询有界的质量信号。
Usage/Quota 采集器通过认证的 `POST /api/control/telemetry` 接入并以
`idempotencyKey` 去重；Codex 原生 JSONL 的累计 token/最近轮次耗时可以实时进入
Ledger，账户级套餐额度在无法证明归属时保持 `unavailable`。

VS Code 内置的 `codex-primary-session` 通过 `/api/coordinator/plan` 和
`/api/coordinator/tick` 执行显式、受策略约束的协调步骤。Fleet 启动的 Codex
终端会在 CLI 生成原生 session id 后被重新绑定到同一 Fleet 实例，不会重复显示。

`fleet.*` MCP 外壳仍是后续适配层；在它完成前，不要把临时脚本当成状态源，直接使用
本地 Control API 或 `FleetControlClient`。
