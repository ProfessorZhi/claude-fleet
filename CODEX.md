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

`fleet.*` MCP / Local API 是 v0.2 目标 Contract。若 Controller 尚未实现，使用
现有 Adapter / runner 做实验，但不要把临时脚本当成最终 Ownership 模型。
