# Delivery Closure Design

```text
Mission / WorkItems
        ↓
CoordinatorScheduler
        ↓ policy + dependencies + retry
FleetControlService
   ├── RuntimeTaskDelivery (host boundary)
   ├── FleetLedgerStore (durable snapshot)
   ├── TelemetryIngestor (normalized usage/quota)
   └── ScmReadOnlyAdapter (git/PR/CI evidence)
```

Scheduler 只推进显式的 WorkItem 和已批准的 launch/assignment 请求；它不解析
Agent 对话，也不自行获得新的权限。Runtime task delivery 只接受 bounded task brief，
由 Claude/Codex Host 决定如何写入已经存在的受管理终端。

Telemetry 和 SCM 适配器只产生结构化事实，所有写入继续通过 Ledger 的 secret-free
validation。没有可靠来源时返回 unavailable，而不是推断 quota、cost 或质量。
