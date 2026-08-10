# ROADMAP.md — Claude Fleet → Agent Fleet

> 阶段推进按 Exit Criteria，而不是日历日期。  
> 产品定位见 [`PROJECT.md`](./PROJECT.md)；目标架构见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；资源/历史/调度设计见 [`FLEET_LEDGER_AND_SCHEDULING.md`](./FLEET_LEDGER_AND_SCHEDULING.md)。

---

## 已完成基础：Claude Code Alpha

```text
001 multi-instance-runtime                   ✅
002 provider-model-isolation                 ✅
003 instance-status                          ✅ Alpha scope
004 minimal-control-ui                       ✅ Alpha scope
005 provider-registry-session-continuity     ✅
006 branding-discovery-migration             ✅
```

现有基础包括：

- 多 Claude Code CLI Instance；
- Repo / Session 管理；
- Provider / Model 隔离；
- Provider Registry / Profile；
- native Resume / Switch Provider continuity；
- Auto Discovery；
- Pixel Agents 可视化基线；
- Claude Fleet branding / state migration。

当前 Alpha 仍需要继续做真实 Development Host 稳定性验证，但架构目标已经扩展到 Claude Code + Codex CLI 双 Runtime。

---

# v1 核心目标

> **Claude Code CLI + Codex CLI 的统一多实例管理，并形成 Runtime-neutral 的本地 Coding Agent Control Plane。**

```text
Mission
└── Coordinator
    ├── Claude Code CLI
    └── Codex CLI

Fleet Instances
├── Claude Code CLI × N
└── Codex CLI × N
```

核心原则：

```text
Runtime != Role
Telemetry != Ledger
Token != Cost != Quota
Recommendation != Execution
```

---

## Phase A — Stabilize Existing Claude Runtime

**目标**：先保证现有 Claude Code 能作为未来 Runtime Adapter 的稳定基线。

主要工作：

- Development Host 真人测试；
- Claude CLI executable discovery；
- `.vscode/launch.json` / `tasks.json`；
- 真实 DeepSeek / MiniMax Profile launch；
- Restart / Resume；
- Switch Provider continuity；
- ≥2 Claude Instances 同时运行；
- Auto Discovery；
- Stop A 不影响 B。

**Exit Criteria**：

```text
[ ] Claude Code CLI 能从 Development Host 稳定启动
[ ] ≥2 Claude Instances 可并行
[ ] Provider/Profile 注入真实可用
[ ] Restart/Resume 不丢原生 Session
[ ] Switch Provider 不静默 fork
[ ] External Claude Discovery 正常
```

---

## Phase B — Runtime-neutral Control Plane

**目标**：把现有 Claude-specific 多实例管理抽成支持多 Runtime 的统一模型。

新增 / 抽象：

```text
FleetInstance
RuntimeType
RuntimeCapabilities
RuntimeAdapter
Mission
Role
CoordinatorRef
Repo / Worktree / Session
```

v1 Runtime：

```text
claude-code
codex-cli
```

角色：

```text
coordinator
worker
reviewer
debugger
```

**约束**：

- Claude Provider Registry 不得退化；
- 不强迫 Codex 伪装成 Claude Provider 模型；
- Runtime capability 必须真实表达 supported / unsupported；
- Vendor-specific 逻辑留在 Adapter。

**Exit Criteria**：

```text
[ ] UI / Store 不再把所有 Instance 写死为 Claude
[ ] Runtime 与 Role 解耦
[ ] Mission 可组织多个 Instance
[ ] Coordinator 可以引用一个 managed Instance
[ ] Claude Code 现有功能全部回归通过
```

---

## Phase C — Unified Observability

**目标**：建立 Runtime-neutral 的实时状态边界。

```text
Claude Hooks / JSONL ─┐
Codex signals ────────┤
Process state ────────┤
Git state ────────────┘
                      ↓
                   FleetEvent
                      ↓
               FleetTelemetryStore
```

第一版关注：

- Starting / Working / Waiting / Idle / Error / Stopped；
- current tool / task（可靠时）；
- session / runtime / role / repo；
- recent events；
- errors；
- bounded timeline。

**Exit Criteria**：

```text
[ ] Claude raw event 不直接泄漏给通用 UI
[ ] FleetEvent 可表示两种 Runtime 的共同状态
[ ] 不可获取字段显示 unavailable
[ ] Telemetry 不含 Secret
[ ] Recent Timeline 有界
```

---

## Phase D — Codex CLI Runtime Adapter

**目标**：让 Codex CLI 成为与 Claude Code CLI 同级的一等 Managed Runtime。

主要内容：

- Codex CLI executable resolver；
- Launch / Stop / Focus；
- Repo / cwd / Worktree 绑定；
- Session identity；
- Restart / Resume（严格按 Codex 原生能力）；
- Status / Telemetry adapter；
- Auto Discovery（仅在有可靠机制时）；
- mixed-runtime tests。

**Exit Criteria**：

```text
[ ] ≥2 Codex CLI Instances 可并行
[ ] Claude + Codex 可以同时运行
[ ] Stop 一个 Instance 不影响其他 Instance
[ ] 每个 Instance Repo / Session 独立
[ ] Codex 状态进入 FleetEvent
[ ] Focus 打开正确 Codex Terminal
```

---

## Phase E — Mission + Coordinator Workflow

**目标**：让多实例形成有主线程和角色关系的工作单元。

支持：

- Mission create/select；
- Role assignment；
- 任意 managed Claude/Codex Instance 设置为 Coordinator；
- Coordinator 卡片；
- Worker / Reviewer 展示；
- Repo / Worktree 风险提示；
- Handoff / recent events 展示。

Codex Desktop 可以作为 optional External Coordinator，但不是核心依赖。

当前已实现一个可审计的最小控制闭环：Mission/WorkItem 创建、推荐、显式分配、
边界化结果回收和 normalized usage/quota 写入。当前补齐了显式 Scheduler（依赖、并发、
幂等和有上限重试）、authenticated Coordinator plan/tick session、bounded Runtime task delivery、
自动结果关联，以及只读 SCM/PR/CI evidence adapter；
完整后台自治循环和真实外部 Provider 连接器仍属于后续工作。

**Exit Criteria**：

```text
[ ] Claude Instance 可当 Coordinator
[ ] Codex Instance 可当 Coordinator
[ ] 更换 Coordinator 不重建 Runtime
[ ] Mission 与 Role 不依赖 Runtime 类型
```

---

## Phase F — Fleet Ledger + Resource Accounting

**目标**：建立长期元信息账本和统一资源模型，为后续效率评估和调度提供事实基础。

新增：

```text
MissionRecord
WorkItemRecord
SessionRecord
PullRequestRecord
UsageRecord
QuotaSnapshot
QualitySignal
AssignmentDecision
ResourceAccount
```

资源模式必须支持：

```text
metered API
Token Plan / Credit Plan
subscription / Plus / Pro
rate-limit / custom budget
```

例如：

```text
DeepSeek API → token + estimated/actual API cost
MiniMax     → token-plan / quota snapshot（有可靠来源时）
Subscription→ remaining quota（仅官方/runtime可靠暴露时）
```

Unknown quota 不等于 Unlimited。

当前 Ledger 已支持 secret-free、版本化、原子快照 persistence、Session/Usage/Quota 查询和
Coordinator Assignment Decision；Telemetry ingestion 已接入 normalized usage/duration/cost/quota
边界。没有可靠来源时 quota 明确为 unavailable，不把账户百分比伪装成任务额度。

**Exit Criteria**：

```text
[ ] Telemetry 与 Ledger 分离
[ ] Token / Cost / Quota 分离
[ ] ResourceAccount 与 Runtime 解耦
[ ] 每个 Session / Task 可记录时间与 Usage 元信息
[ ] 默认不保存完整 Prompt / Transcript / Secret
```

---

## Phase G — SCM / PR / Quality Metrics

**目标**：知道每个 Agent 实际产出了什么、一个 PR 花了多久、质量如何。

通过 SCM Adapter 获取：

```text
branch / commit
PR opened
CI status
review findings
review rounds
merge / close / revert
```

当前已交付只读 SCM/PR/CI/review adapter 和安全质量信号投影；它使用注入式 provider，
缺少真实 GitHub/GitLab/CI 凭据或连接器时明确返回 unavailable，不执行 commit、merge、
push、delete，也不把完整 diff 写入 Ledger。

派生：

```text
Time to first edit
Time to first commit
Time to PR
Time to CI green
PR cycle time
Rework count
First-pass CI rate
First-pass review rate
Merge / revert rate
```

Quality 必须可解释，不只给黑盒模型分数。

**Exit Criteria**：

```text
[ ] PR 可以关联 Mission / WorkItem / FleetInstance
[ ] PR 时间成本可查询
[ ] PR Token / Cost 可汇总
[ ] Quality 有 CI / Review / Rework breakdown
[ ] Ledger 可长期查询 Agent 历史表现
```

---

## Phase H — Metrics Engine + Recommendation Panel

**目标**：在不自动执行的情况下，先给 Coordinator / 用户可解释的任务分配建议。

考虑因素：

```text
Capability match
历史同类任务质量
历史同类任务耗时
Token 成本
API 成本
当前负载
Context headroom
剩余额度 / budget
quota reset
Repo / Worktree conflict
priority / deadline
```

候选既包括现有 Instance，也包括 Launch Template：

```text
Existing Claude #2 / DeepSeek
Launch Claude Code / MiniMax
Existing Codex #1
```

建议栏示例：

```text
Launch Claude Worker · MiniMax
- 有独立任务可并行
- 现有 Worker 正忙
- MiniMax quota 健康
- 避免增加 DeepSeek 按量 API 支出
```

**Exit Criteria**：

```text
[ ] 推荐结果有 reasons / source / uncertainty
[ ] 可以建议“新开 Agent”而不直接执行
[ ] Strategy 不包含散落的 vendor-specific if/else
[ ] 支持至少 balanced / speed / cost / quality 方向的策略接口
```

---

## Phase I — Fleet Command Scene

**状态（2026-08）**：三种共享数据前端已实现，Task Control Center 为默认 Scene，且已完成 Scene First 信息架构收敛。
Fleet Command 与 Pixel Office 作为可选投影，并与 Task Control Center 共享 Agent / Telemetry / Command 数据；
Mission 的真实上游数据与正式 sprite 资产仍按后续任务推进，Canvas greybox 与状态事件动画
已接入。

**目标**：从 Pixel Office 扩展出符合 Fleet 品牌的 Pixel Sci-Fi Scene，同时保留 Pixel Agents 的行为细节。

```text
Runtime / Telemetry
       ↓
    Scene Model
       ↓
├── Task Control Center（默认）
├── Fleet Command
└── Pixel Office
```

Fleet Command 重点：

- Agent Instance → Vessel；
- Coordinator → Flagship；
- Worker → Frigate；
- Reviewer → Recon Vessel；
- Subagent → Drone；
- Working / Waiting / Error / Completion 对应真实动画；
- 点击 Vessel → 真实 Instance；
- Focus → 真实 CLI Terminal；
- Telemetry / Ledger / Recommendation 使用现代 VS Code UI；
- 紧凑 Command Bar + Mission Rail，主场景优先，Instance Detail 按需出现；
- Terminal Dock 与 Timeline/Recommendation 以薄条呈现，路径与工程细节不进入舰船卡片；
- Pixel Office 保持可切换。

---

## Phase J — Fleet Control API / MCP + Policy Execution

**目标**：让 Coordinator 在明确规则内使用 Fleet 作为控制工具。

权限模式：

```text
observe
suggest
approve
autonomous
```

默认先实现：

```text
suggest → approve
```

控制能力：

```text
fleet.list_candidates()
fleet.get_resource_status()
fleet.get_metrics()
fleet.recommend_assignment()
fleet.launch_instance()
fleet.assign_work_item()
fleet.deliver_work_item()
fleet.stop_instance()
```

用户给出：

```text
Task List
Dependencies
Capabilities
Priority
Cost / Quota Rules
Concurrency Rules
Approval Policy
```

Coordinator 可以通过显式 Scheduler tick 循环调度。当前循环是 bounded、幂等且受 policy
控制的执行器；它不会自行解析对话、绕过审批或无限启动进程。

**硬 Guardrails**：

```text
max concurrent agents
max agents per mission
metered API budget
quota reserve
allowed runtime/provider/model
allowed repo
worktree isolation
review-before-merge
approval for destructive actions
```

完全 autonomous 必须后于 Ledger / Metrics / Recommendation，并且不能绕开审计。

---

## Phase K — Agent Fleet Brand Migration

**触发条件**：Claude Code CLI + Codex CLI 都达到稳定一等 Runtime 支持，核心 UI / Domain 已不依赖 Claude-specific 命名。

```text
Claude Fleet → Agent Fleet
```

建议最终：

```text
Product: Agent Fleet
Repository: agent-fleet
Tagline: Local Control Plane for Coding Agents
```

迁移包括但不限于：

```text
ClaudeFleetViewProvider → AgentFleetViewProvider
CLAUDE_FLEET_DEBUG      → AGENT_FLEET_DEBUG
~/.claude-fleet         → ~/.agent-fleet
commands / config keys / package / docs / assets / webview
```

必须保留兼容迁移和 Pixel Agents attribution。

---

# v1 之后：更多 Runtime / Adapter

核心接口从一开始保留扩展性，后续可以接：

```text
Gemini CLI
OpenCode
Qoder CLI
Custom Agent Runtime
```

扩展边界：

```text
RuntimeAdapter       → CLI lifecycle/session/events
ResourceAdapter      → token/cost/quota/subscription
ObservabilityAdapter → external measurement tools
SCMAdapter           → GitHub/GitLab/local Git
StrategyAdapter      → assignment policies
```

新增一个 Runtime 不应该要求重写 Mission、Ledger、Metrics、Strategy 或前端。

---

# 目标 Exit Criteria

```text
[ ] Claude Code CLI × N
[ ] Codex CLI × N
[ ] Claude + Codex mixed fleet
[ ] Repo / Worktree / Session isolation
[ ] Mission
[ ] Runtime-neutral Role
[ ] Any managed Claude/Codex can be Coordinator
[ ] Unified FleetEvent / Telemetry
[ ] Fleet Ledger long-term metadata
[ ] Token / Cost / Quota accounting
[ ] PR / CI / Review metrics
[ ] Explainable Recommendation Panel
[x] Policy-controlled Coordinator launch/assign
[ ] Real terminal Focus / lifecycle control
[ ] Claude Provider/Profile capability preserved
[x] Fleet Command + Pixel Office switchable scenes
[x] No secrets in telemetry or ledger
[x] Git/spec/tasks remain collaboration source of truth
```
