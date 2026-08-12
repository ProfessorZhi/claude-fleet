# Billing Observability Requirements

## Goal

让一个 WorkItem/PR 可以同时展示三种互不替代的成本口径：

1. 运行时实际观测到的 token 数量；
2. 按当前模型公开 API 单价折算的 API 等价价格；
3. 按订阅/Token Plan 额度变化分摊的订阅成本。

计量粒度必须是“轮 → Session → PR/WorkItem”：每一轮对话保留独立的
`turnId`、Token、耗时、价格和 quota 边界证据；同一 Session 的多轮先聚合，
一个 PR/WorkItem 再聚合多个 Session。一个 `usageId` 只能计入一次。

## Requirements

1. `UsageRecord.tokens` 继续表示真实观测 token，不得由 quota 百分比推导。
2. API 等价成本、按量计费成本、订阅摊销成本必须分别存储和分别聚合。
3. 订阅成本必须记录套餐类型、计费周期、周期价格、价格来源、额度消耗比例和
   归属置信度。
4. provider quota 的 before/after 百分比变化可以形成订阅额度影响；跨 session/
   PR 聚合时按 WorkItem 汇总，并保留 reset/ambiguous/unavailable 状态。
5. OpenAI/Codex、MiniMax Token Plan 的套餐类型和额度快照可以在有官方本地/账户
   只读来源时自动读取；无法证明任务归属时不能伪造 quota 消耗。
6. 官方标价是默认的 `official-list` 基准；用户可以用本地配置或发票记录覆盖为
   `user-entered`/`invoice`，以支持活动价、人民币实付价和团队分摊。
7. 真实 API 按量计费保留 `metered`；订阅用户也必须同时保留 API 等价价格，不能
   因为没有 API 账单就把 API 等价价写成实际账单。
8. 旧版只带 `cost` 的 UsageRecord 仍可读取；新写入应优先填充显式 breakdown。
9. 累计式运行时快照只能在 Session 聚合时取最新一条，不能把轮询快照重复相加；
   明确标记为 `turn` 的记录逐条相加。
10. 所有新字段都必须通过现有 telemetry secret/原始 transcript 安全边界。

## Non-goals

- 不自动读取浏览器 cookie、支付卡、发票全文或 API key。
- 不把 quota 百分比当作 token 数量。
- 不把官方标价或用户填写的活动价声称为 provider 的实际账单。
