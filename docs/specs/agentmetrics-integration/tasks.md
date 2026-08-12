# 007-agentmetrics-integration — Tasks

## A. Spec 与迁移边界

- [ ] A1. 将原 `agent-metrics-collector` 的 tracked source 清单固定下来，排除 `.git`、
      `.local`、缓存、egg-info、worktrees 和 smoke target。
- [ ] A2. 在 `docs/ROADMAP.md` 和 `docs/specs/README.md` 登记本 Spec。

## B. 单仓库合并

- [ ] B1. 创建主仓库 `agentmetrics/` 目录并迁移 source、tests、schemas、config、scripts、
      docs、`pyproject.toml`、`agent-metrics.ps1` 和 README。
- [ ] B2. 将合并后的 Python 测试入口固定为 `agentmetrics/` 工作目录，确认
      `PYTHONPATH=agentmetrics/src` 可运行。
- [ ] B3. 添加主仓库 `.gitignore` 规则，禁止 metrics 运行数据和 Python 构建产物进入主仓库。
- [ ] B4. 保留原 metrics 仓库不变，记录迁移源 commit。

## C. Fleet identity contract

- [x] C1. 新增 `core/src/fleetContracts.ts`，定义 Fleet identity 和运行关联类型。
- [x] C2. 新增或扩展 JSON schema，覆盖 `fleet_run_id`、`fleet_task_id`、`fleet_worker_id`、
      `fleet_coordinator_id`、`parent_worker_id`、`worker_role`、`worktree_id`、`attempt`。
- [x] C3. 为 Python run context / sanitized summary 增加可选 `fleet` 字段，并保持旧 schema 兼容。
- [x] C4. 为 Python CLI 的 `start` 和 PowerShell runner 增加可选 Fleet identity 参数及环境变量透传。
- [x] C5. 增加精确关联和 identity 校验的回归测试。

## D. Claude Fleet 接入准备

- [ ] D1. 在 `PersistedAgent` 和 Worker launch intent 中增加 secret-free Fleet identity 引用。
- [ ] D2. 让 launch flow 能将 identity 传给 metrics runner；未配置 metrics 时保持原有启动流程。
- [ ] D3. 将 UsageRecord / summary path 作为 Agent result 的可选引用，不把原始 prompt 或 response 写入 Fleet state。

## E. Validate / Review

- [x] E1. 运行原 agentmetrics Python test suite。
- [ ] E2. 运行 Claude Fleet typecheck、lint、server/webview tests。
- [x] E3. 用 fake Codex / fake Claude runner 验证一次完整 Fleet identity → summary 链路。
- [x] E4. 检查 `git diff`，确认没有 `.git`、secret、raw transcript、`.local` 或用户路径泄露。
- [ ] E5. 更新迁移说明和下一阶段 Scheduler/MCP Spec 的依赖关系。
