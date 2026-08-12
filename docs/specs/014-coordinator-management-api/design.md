# Coordinator Management API — Design

`FleetControlService` 仍是唯一的 management-plane state owner。HTTP 只负责认证、
输入转发和安全序列化；`FleetControlClient` 是 Coordinator 的 typed client。

```text
Codex Coordinator
        ↓ Bearer HTTP
FleetControlClient
        ↓
FleetControlService ── FleetLedgerStore
        ↓
RuntimeAdapter + FleetRuntimeHost
        ↓
terminal / session / Agent runtime
```

`restart_instance` 与 `resume_instance` 使用 Host 的 launch boundary，传递既有
instance metadata 和 `sessionMode: resume`；restart 先停止旧 instance。这样不会让
ControlService 直接 spawn 子进程，也不会绕过 VS Code Terminal Host。

`GET /api/control/instances` 返回受安全序列化的 roster；`GET .../:instanceId`
返回单实例。List/status 是查询，不改变 ledger；side effect 仍通过 POST control
request，保持幂等 `requestId` 语义。

`GET /api/control/metrics?instanceId=...` 返回 Ledger 中已经观测到的 usage、session
elapsed 和 quota snapshot。Session elapsed 对活动 session 使用
`capturedAt - startedAt`；usage duration 只在没有对应 session 时补计，避免重复累计。
Quota 保持独立证据源，Coordinator 不能把 token usage 当成 quota remaining。
