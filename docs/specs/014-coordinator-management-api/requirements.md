# Coordinator Management API — Requirements

## Goal

让一个本地 Codex Coordinator 能通过稳定的控制平面管理多个 Claude/Codex
Worker，而不依赖 UI 点击或 Computer Use。

## Requirements

1. Coordinator 可以通过本地认证 HTTP API 查询全部 Fleet instances，并按
   instance id 查询单个 instance。
2. Coordinator 可以对 Fleet-owned instance 执行 launch、focus、stop、restart
   和 resume；每次 side effect 都经过 `approve` 或 `autonomous` 模式，并留下
   ControlDecision 与 Launch/Session ledger 记录。
3. Restart/Resume 保留 instance identity、Repo、Provider/Model 与 session
   continuity；运行时不支持 resume 时返回可诊断的 `unavailable`，不伪造成功。
4. 多个 instance 的终端、session、Repo 和 Provider/Model 元数据互相隔离。
5. Coordinator 可以查询 token usage 总量、session elapsed time 和独立来源的 quota snapshot；Fleet 不得从 token 总量推导 quota remaining。
6. 主规划/管理 Session 是 Coordinator，不是 Worker；每个 Worker 仍按 instance/session/repo/runtime 独立寻址。
7. 查询与错误响应不泄漏 Bearer token、环境变量、transcript、prompt 或原始
   runtime payload。
8. 测试使用 fake RuntimeAdapter/Host，不启动真实 Claude/Codex，不消耗 API 额度。

## Non-goals

- 本 Spec 不实现调度器、MCP server 或云端持久化。
- `collect_result` 仍需独立的 Result contract；在该 contract 形成前必须明确返回
  `unavailable`。
