# Delivery Closure Requirements

本 Spec 收敛 Agent Fleet 交付版剩余缺口，范围限定为可验证的本地控制平面能力。

## 必须完成

- Coordinator 能按 WorkItem 依赖、并发上限和重试策略自动推进可执行任务。
- Coordinator 能把不含 Secret/raw transcript 的任务简报投递到受管理 Runtime 的终端边界。
- agentmetrics 的 normalized summary 能通过明确的 ingestion adapter 自动写入 Fleet Ledger。
- SCM/PR/CI 结果有安全的只读采集边界，不能把 GitHub token 或完整 diff 写入 Ledger。
- Claude/Codex fake mixed-runtime 测试覆盖 launch、assign、deliver、collect、usage 和 retry。

## 明确不在本轮

- 不启动真实 Claude/Codex 任务。
- 不实现自治合并、删除 Worktree、推送代码或绕过审批。
- 不把 raw prompt、transcript、环境变量、Token 或 Provider Secret 保存到 Fleet 状态。
- 不继续扩展 Fleet Command 美术；Office 仍为默认 Scene。
