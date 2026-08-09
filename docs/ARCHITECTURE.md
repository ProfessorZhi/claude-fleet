# ARCHITECTURE.md — Claude Fleet v1 Target Architecture

> 本文同时描述 **当前实现** 与已经确定的 **v1 目标架构**。  
> 当前代码名仍为 **Claude Fleet**；当 Codex CLI 与 Claude Code CLI 都成为一等 Runtime 后，产品品牌计划迁移为 **Agent Fleet**。
>
> 产品定位见 [`PROJECT.md`](./PROJECT.md)；阶段规划见 [`ROADMAP.md`](./ROADMAP.md)；Codex + Claude Code 协作方式见 [`WORKFLOW_CODEX_CLAUDE.md`](./WORKFLOW_CODEX_CLAUDE.md)；长期 Ledger / 资源 / 调度设计见 [`FLEET_LEDGER_AND_SCHEDULING.md`](./FLEET_LEDGER_AND_SCHEDULING.md)。

---

## 1. 一句话定位

Claude Fleet / future Agent Fleet 是一个 **本地 Coding Agent Control Plane（控制平面）**：

- 在 VS Code 中统一启动、管理和观察多个 Coding Agent CLI Session；
- v1 正式支持 **Claude Code CLI + Codex CLI 多实例**；
- 每个实例绑定 Repo / Worktree / Session / Runtime / Role；
- Claude Code 实例继续支持独立 Provider / Model / Profile；
- 统一展示状态、进度、工具调用与近期事件；
- 一个 Mission 可以指定任意一个受支持实例为 Coordinator；
- Codex Desktop / Client 可以作为可选的 External Coordinator，但不是核心 Runtime 依赖。

Fleet **管理真实 Runtime**，不重新实现 Claude Code 或 Codex。

---

## 2. v1 目标：Claude Code + Codex 多实例管理

v1 不再把 Codex CLI 放在遥远的未来。

目标拓扑：

```text
                         Mission
                           │
                    Coordinator Role
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   Claude Code CLI     Codex CLI       Claude Code CLI
      Instance A       Instance B         Instance C
       Worker          Reviewer          Debugger
          │                │                │
          └────────── Git / Spec / Repo ───┘
                           │
                           ▼
                    Fleet Control Plane
                           │
          Runtime + Session + Telemetry + UI
```

v1 的一等 Managed Runtime：

```text
Claude Code CLI
Codex CLI
```

同一 Mission 中允许：

```text
Claude Code CLI → Coordinator
Codex CLI       → Coordinator
Claude Code CLI → Worker
Codex CLI       → Worker / Reviewer / Debugger
```

核心原则：

```text
Runtime != Role
```

不要在架构中写死：

```text
Codex = Coordinator
Claude = Worker
```

---

## 3. 当前实现基线

当前仓库已经完成的主要能力仍以 Claude Code Runtime 为主：

```text
Claude Fleet
│
├── Provider Registry
│   ├── ProviderDefinition
│   └── ProviderProfileStore
├── Secret Store
├── Session Registry
├── Instance Manager
├── Auto Discovery
├── Status / Event Stream
├── Pixel UI
│
└── Claude Code Runtime Adapter
    ├── resolveClaudeLaunchConfig
    ├── buildLaunchCommand
    ├── ClaudeFleetServer
    └── native `claude` CLI
```

已有能力包括：

- 多 Claude Code CLI Instance；
- Repo / Session 管理；
- Provider/Profile/Model 隔离；
- Restart = native Resume；
- Switch Provider 时保持 native Session；
- Auto Discovery；
- Pixel Agents 可视化基线；
- Hook + JSONL 状态来源；
- Fleet-managed / External 区分。

v1 的下一步不是重写这些，而是在它们上方抽出 Runtime-neutral Control Plane，并增加 Codex CLI Adapter。

---

## 4. Fleet 不是新的 Agent Runtime

Fleet 不做：

```text
Claude Code replacement
Codex replacement
自定义 Conversation Engine
把 transcript 复制成 prompt 来模拟 Resume
重新实现 /help /mcp / skills / hooks / permissions
重新实现 Codex CLI 的内部交互
```

真实执行始终由原生 CLI 完成：

```text
claude
codex
```

Fleet 负责的是：

```text
Launch
Focus
Stop
Restart / Resume（Runtime 支持时）
Repo / Worktree
Session identity
Role
Provider / Model（Runtime 支持时）
Status
Telemetry
Visualization
```

---

## 5. Mission 是顶层工作单元

单个 Agent Instance 不是最高层对象。

v1 引入轻量 **Mission** 概念，用来描述“一件正在由多个 Agent 完成的开发工作”。

示例：

```text
Mission: Fleet Scene Redesign
Repo: claude-fleet

Coordinator
└── Codex CLI #1

Instances
├── Claude Code #1 — Frontend Worker
├── Claude Code #2 — Telemetry Worker
└── Codex CLI #2 — Reviewer
```

建议最小模型：

```ts
interface Mission {
  id: string;
  name: string;
  repo?: string;
  coordinatorRef?: CoordinatorRef;
  instanceIds: string[];
}
```

第一版 Mission 是**组织和可观测边界**，不是自动规划器。

不要在 v1 为 Mission 实现复杂 DAG Scheduler、自动任务分解或 Agent-to-Agent Chat Bus。

---

## 6. Runtime 与 Role 解耦

统一角色建议：

```text
Coordinator
Worker
Reviewer
Debugger
```

后续可以增加 Researcher 等角色，但不要影响核心模型。

统一 Runtime 类型：

```text
claude-code
codex-cli
```

未来其他 Runtime 通过 Adapter 扩展。

概念模型：

```ts
interface FleetInstance {
  id: string;
  runtimeType: 'claude-code' | 'codex-cli';
  role: 'coordinator' | 'worker' | 'reviewer' | 'debugger';

  cwd: string;
  repo?: string;
  worktree?: string;
  sessionId?: string;

  status: FleetStatus;
  managedByFleet: boolean;

  providerProfileId?: string;
  modelId?: string;
}
```

注意：字段必须按 Runtime capability 使用。

例如 Provider/Profile 是 Claude Code 当前已有的重要能力；不要假装 Codex CLI 一定具有完全相同的 Provider 模型。

---

## 7. Runtime Adapter 层

v1 目标：

```text
Fleet Runtime Layer
├── ClaudeCodeRuntimeAdapter
└── CodexCliRuntimeAdapter
```

Adapter 负责把不同 CLI 的能力归一化到 Fleet Control Plane。

建议 capability-oriented，而不是强迫所有 Runtime 实现同样的方法：

```ts
interface RuntimeCapabilities {
  launch: boolean;
  stop: boolean;
  focus: boolean;
  restart: boolean;
  resume: boolean;
  discover: boolean;
  observe: boolean;
  providerProfiles: boolean;
  modelSelection: boolean;
}
```

Runtime Adapter 必须诚实报告能力。

不知道 / 不支持时：

```text
unsupported / unavailable
```

禁止伪造兼容行为。

---

## 8. Coordinator 设计

Coordinator 是 **Mission 中的逻辑角色**，不是固定产品，也不是必须嵌入左侧的聊天窗口。

### Managed Coordinator

如果 Coordinator 是：

```text
Claude Code CLI
Codex CLI
```

Fleet 可以完整管理：

- Focus 到对应 Terminal；
- 展示 Session / Repo / Role / Status；
- 展示 Telemetry；
- Stop / Restart / Resume（按 Runtime 支持能力）。

### External Coordinator

Codex Desktop / Client 可以作为可选外部主线程：

```text
Codex Desktop
→ External Coordinator
```

此时 Fleet 只保存可靠 metadata：

```text
Mission
Role
Repo association
Display name
Optional external reference
```

Fleet 不应依赖私有协议：

- 不强行嵌入 Codex Desktop UI；
- 不读取完整聊天记录；
- 不自动把每个 Codex Desktop Thread 变成 Worker；
- 没有稳定官方能力时不声称能控制该 Thread。

因此 v1 的核心能力不依赖 Codex Desktop；最完整模式是全部使用 Fleet-managed Claude Code / Codex CLI。

---

## 9. 是否需要在 Codex Desktop 中大量开 Thread

不是 Fleet 的推荐执行模型。

不推荐：

```text
Codex Desktop
├── Thread A Coordinator
├── Thread B Worker
├── Thread C Reviewer
└── Thread D Debugger
```

因为 Fleet 难以可靠管理这些外部 Thread 的：

- cwd；
- Repo / Worktree；
- process 生命周期；
- session identity；
- tool activity；
- status；
- telemetry；
- Stop / Restart / Resume。

推荐：

```text
Coordinator
├── Codex Desktop（可选 external）
├── Codex CLI（managed）
└── Claude Code CLI（managed）

Workers / Reviewers
├── Claude Code CLI
└── Codex CLI
```

Codex Desktop 的额外 Thread 可以用于独立研究或 brainstorm，但不是 Fleet v1 Worker 模型的核心。

---

## 10. Control Plane 分层

v1 建议保持四层。

### 10.1 Domain / Control Plane

```text
Mission
FleetInstance
Role
CoordinatorRef
Repo / Worktree
Session
RuntimeCapabilities
```

### 10.2 Runtime Layer

```text
ClaudeCodeRuntimeAdapter
CodexCliRuntimeAdapter
```

### 10.3 Observability Layer

```text
Claude Hooks ───────┐
Claude JSONL ───────┤
Claude AgentState ──┤
Codex events/logs ──┤
Process state ──────┤
Git state ──────────┘
                    ↓
                 FleetEvent
                    ↓
             FleetTelemetryStore
```

### 10.4 Presentation Layer

```text
Mission View
Coordinator Panel
Fleet List
Telemetry Panel
Recent Timeline
Fleet Command Scene
Pixel Office Scene
```

关键约束：UI 不直接解析 Claude JSONL 或 Codex-specific raw event。

---

## 11. Unified Observability Boundary

建立统一：

```text
FleetEvent
```

典型事件：

```text
instance_started
instance_stopped
session_started
session_resumed
working
waiting
idle
error
tool_started
tool_finished
task_started
task_finished
subagent_started
subagent_finished
provider_switched
handoff
```

并维护轻量：

```text
FleetTelemetryStore
```

每个 Instance 的 Snapshot 可包含：

```text
instanceId
runtimeType
role
managedByFleet
repo
cwd
worktree
sessionId
providerProfileId
providerDisplayName
modelId
status
currentTool
currentTask
contextUsage
contextLimit
lastActivityAt
error
```

所有不可可靠获取的字段必须允许：

```text
unknown / unavailable
```

禁止根据动画、文件修改或模型类型猜数据。

---

## 12. Telemetry 安全原则

Telemetry 绝不能包含：

```text
API Key
Auth Token
SecretStorage value
Authorization header
完整环境变量
```

只允许安全 metadata：

```text
Runtime
Provider display name
Model ID
Repo
Session ID
Status
Tool name
Task description
Timing / event metadata
```

第一版 Recent Timeline 只维护有限历史，例如最近 50~100 个事件。

不要一开始实现 Jaeger / Grafana clone。

---

## 13. Claude Code Provider / Profile 设计继续保留

当前 Provider Registry 仍然有效：

```text
ProviderDefinition
→ Provider 类型 / preset

ProviderProfile
→ 用户实际配置且启用的实例
```

当前支持方向：

```text
Anthropic Account
Anthropic API
Amazon Bedrock
Google Vertex AI
Microsoft Foundry
DeepSeek
MiniMax
Custom Anthropic-compatible
```

New Agent 只显示 configured + enabled profiles。

Provider / Model 必须 per-instance，不覆盖全局 `~/.claude/settings.json`。

Secret 使用 VS Code SecretStorage。

当前 Claude Code Session continuity：

```text
Restart         → native resume
Switch Provider → same native session + new provider environment
New Session     → fresh session
```

Resume 失败不得静默 fork。

这些能力在 Runtime-neutral 重构时必须回归测试，不能为了 Codex Adapter 把 Claude Code 现有能力做退化。

---

## 14. Auto Discovery

Claude Code 当前 Auto Discovery 必须保留：

```text
Fleet-managed Claude
→ Managed: Fleet
→ 可恢复 Fleet provider/model metadata

External manually launched Claude
→ Managed: External
→ Provider: Unknown（无法可靠确认时）
```

同 native Session 在 Restart / Switch / Resume 后必须 upsert，不重复创建 Instance。

v1 Codex CLI Adapter 应尽可能提供等价 discovery；如果 Codex CLI 暂时没有可靠 discovery 信号，则明确标记 capability 缺失，不使用脆弱猜测。

---

## 15. Repo / Worktree 是并行隔离边界

多个 Agent 不应默认同时写同一个 `main` checkout。

推荐：

```text
Mission
├── worktree A / branch A → Worker A
├── worktree B / branch B → Worker B
├── worktree C / branch C → Reviewer / Fixer
└── main                  → integration
```

如果 Fleet 能可靠检测：

```text
same repo + same checkout + multiple active writers
```

UI 应提示冲突风险。

Git / Specs / Tests 是跨 Agent 的 source of truth。

不要把某个 Agent 的聊天内存当作项目共享状态。

---

## 16. Codex + Claude 多 Agent 工作流

推荐工作循环：

```text
Understand
→ Spec
→ Plan
→ Implement
→ Validate
→ Review
→ Fix
→ Merge
```

共享状态：

```text
AGENTS.md
.agent/
docs/specs/*
Git branches / worktrees
commits
diffs
tests
```

示例：

```text
Mission: Provider Refactor

Codex CLI #1      Coordinator
Claude Code #1    Implementer
Claude Code #2    Test / Debug
Codex CLI #2      Reviewer
```

Agent 之间不默认建设 Chat Bus。

跨 Agent Handoff 优先通过：

```text
Spec
Task status
Git commit
Review notes
Test results
```

详见 [`WORKFLOW_CODEX_CLAUDE.md`](./WORKFLOW_CODEX_CLAUDE.md)。

---

## 17. Frontend：Scene 与 Agent 行为分离

Pixel Agents 的价值不是单纯办公室背景，而是已有细粒度行为：

```text
spawn
working
waiting
idle
error
completion
selection
focus terminal
subagent spawn / finish
team relationship
auto discovery
movement / animation
```

因此新前端不能只是：

```text
办公室 → 星空
小人   → 飞船
```

应该抽象：

```text
Runtime / Telemetry
       │
       ↓
    Scene Model
       │
 ┌─────┴──────────┐
 ↓                ↓
Pixel Office   Fleet Command
```

两种 Scene 使用相同 Instance / Telemetry / Command 数据。

设置：

```text
Visual Scene
● Fleet Command
○ Pixel Office
```

Pixel Office 保留为正式可选 Scene。

---

## 18. Fleet Command Scene

推荐视觉：

> **Pixel Sci-Fi Scene + Modern Developer Dashboard**

而不是全页面游戏化。

### 场景层

使用 32-bit / HD Pixel Art：

```text
Coordinator / Lead → Flagship
Worker             → Frigate
Reviewer           → Recon Vessel
Subagent           → Drone
External Instance  → External / Unknown Vessel
```

Claude Code 与 Codex 的 Runtime 差异可以通过小型 badge / 舰型细节表达，但不要把厂商 Logo 铺满界面。

### 控制层

继续现代 VS Code developer UI：

```text
Runtime
Role
Repo
Worktree
Provider
Model
Session
Status
Current Tool
Current Task
Context
Recent Events
```

### 状态动画

文字仍保持：

```text
Starting
Working
Waiting
Idle
Error
Stopped
```

视觉可以映射：

```text
Starting → engine ignition / undocking
Working  → active engine glow / movement
Waiting  → beacon / hover
Idle     → slow drift / dock
Error    → red alert
Stopped  → powered down
```

点击 Vessel 必须选择真实 Instance；Focus 必须打开对应真实 Terminal。

Subagent 动画必须来自真实事件，而不是随机模拟。

---

## 19. v1 推荐 UI 信息架构

```text
┌─────────────────────────────────────────────────────────────┐
│ AGENT FLEET / CLAUDE FLEET    Mission: ...     status      │
├───────────────────┬───────────────────────────┬─────────────┤
│ COORDINATOR       │                           │ TELEMETRY   │
│                   │        FLEET SCENE        │             │
│ Codex / Claude    │                           │ Selected    │
│ Role / Runtime    │                           │ Instance    │
│ Repo / Mission    │                           │             │
│ [Focus/Open]      │                           │ Runtime     │
│                   │                           │ Role        │
│                   │                           │ Repo        │
│                   │                           │ Session     │
│                   │                           │ Status      │
│                   │                           │ Tool        │
│                   │                           │ [Actions]   │
├───────────────────┴───────────────────────────┴─────────────┤
│ Recent Timeline / Errors / Handoffs                        │
└─────────────────────────────────────────────────────────────┘
```

左侧 Coordinator 不是必须嵌入聊天内容；它只是当前 Mission 主线程的入口与状态卡。

---

## 20. Fleet 与 MCP 的关系

Fleet **不是 MCP 本身**。

MCP 主要解决：

```text
Model → Tool
```

Fleet 解决：

```text
Mission
Runtime
Instance
Session
Role
Lifecycle
Observability
Control
```

但后续可以把 Control Plane 暴露成 Fleet MCP Server，让 Coordinator 主动调用：

```text
fleet.list_instances()
fleet.launch_instance()
fleet.assign_task()
fleet.get_status()
fleet.get_recent_events()
fleet.stop_instance()
```

自动执行必须受 Mission Policy、成本/额度上限和审批模式约束，不能让 Coordinator 绕过 Fleet 直接无限 spawn 进程。

---

## 21. v1 非目标

为了避免 scope creep，v1 不要求：

- 云端分布式 Agent Orchestrator；
- Agent-to-Agent 实时 Chat Bus；
- 自动合并所有 Agent 输出；
- 嵌入 Codex Desktop 私有 UI；
- 把 Codex Desktop 所有 Thread 自动纳管；
- 一次支持所有 Coding Agent；
- Three.js / 重型 3D Fleet Scene；
- 完整分布式 tracing 平台；
- 用 Fleet 替代 Claude Code / Codex 的原生 Session 机制。

v1 核心是：

> **Claude Code CLI + Codex CLI 的可靠多实例管理、角色组织、可观测、资源记录与可视化。**

自动任务分解与完全自治调度不是最初实现的前置条件，但架构必须为它保留清晰接口。

---

## 22. 品牌迁移方向

当前仓库和代码仍使用：

```text
Claude Fleet
ClaudeFleetViewProvider
CLAUDE_FLEET_DEBUG
~/.claude-fleet
```

在 Codex CLI Adapter 达到一等支持后，计划进行独立品牌迁移：

```text
Claude Fleet → Agent Fleet
```

建议最终：

```text
Product: Agent Fleet
Repository: agent-fleet
Tagline: Local Control Plane for Coding Agents
```

迁移时必须保留：

- `~/.claude-fleet` → 新 state dir 的兼容迁移；
- 旧命令 / 设置兼容窗口；
- Pixel Agents MIT attribution；
- THIRD_PARTY_NOTICES。

不要在 Runtime 重构过程中零散改一半品牌。

---

## 23. v1 架构验收标准

v1 架构达到目标至少需要：

```text
[ ] 同一 VS Code 中可以运行多个 Claude Code CLI Instance
[ ] 同一 VS Code 中可以运行多个 Codex CLI Instance
[ ] Claude 与 Codex 可以同时运行
[ ] 每个 Instance 独立 Repo / Worktree / Session
[ ] Runtime 与 Role 解耦
[ ] 任意 managed Claude/Codex Instance 可设为 Coordinator
[ ] Mission 可组织 Coordinator + Workers / Reviewers
[ ] Claude Provider/Profile/Model 隔离不退化
[ ] 两种 Runtime 均进入统一 FleetInstance 模型
[ ] 两种 Runtime 状态进入统一 FleetEvent / TelemetryStore
[ ] UI 不直接依赖某一个 Runtime 的 raw event
[ ] Focus 能打开正确真实 Terminal
[ ] Stop A 不影响 B
[ ] Restart/Resume 遵循对应 Runtime 的原生语义
[ ] Auto Discovery 在有可靠能力的 Runtime 上工作
[ ] Pixel Office 仍可用
[ ] Fleet Command 成为新的默认 Scene
[ ] Scene 切换不影响 Runtime
[ ] Telemetry 不泄漏 Secret
[ ] 多 writer checkout 风险可以被识别或明确无法判断
[ ] Token / Cost / Quota 数据模型彼此分离
[ ] Fleet Ledger 可以保存任务 / Session / PR 的长期元信息
[ ] Assignment / Recommendation 有可解释理由与审计记录
```

---

## 24. 当前开发顺序

在不破坏现有 Claude Code Alpha 的前提下：

```text
1. 稳定现有 Claude Code Runtime
2. 抽 FleetInstance / RuntimeAdapter / Role / Mission
3. 建立 FleetEvent / TelemetryStore
4. 接入 Codex CLI Runtime Adapter
5. 做 Claude + Codex 同时多实例运行验证
6. 建立 Fleet Ledger / Usage / Quota 基础模型
7. 接 Git / PR / CI metrics
8. 实现 Coordinator 可切换
9. 抽 SceneRenderer
10. Fleet Command Pixel Scene
11. Recommendation Panel
12. Fleet Control API / MCP + approve-mode launch/assign
13. 完成后再进行 Agent Fleet 品牌迁移
```

先记录事实，再做推荐；先做推荐，再做自动执行。

---

## 25. Fleet Ledger：长期工作履历

实时 Telemetry 与长期 Ledger 必须分开：

```text
Telemetry → 当前谁在做什么
Ledger    → 历史谁做过什么、结果如何、资源花了多少
```

Ledger 至少覆盖：

```text
MissionRecord
WorkItemRecord
SessionRecord
PullRequestRecord
UsageRecord
QuotaSnapshot
QualitySignal
AssignmentDecision
```

默认只保存结构化元信息，不复制完整 Prompt / Transcript / 源文件。

典型历史记录：

```text
Agent: Claude Code #2
Task: Fleet Scene
PR: #42
Time to PR: 22m
PR cycle: 45m
Tokens: 284k
Estimated cost: $1.73
CI failures: 0
Review rounds: 1
Outcome: merged
```

PR 质量不能只由模型主观打分，应来自 CI、Review、返工、回归、Merge/Revert 等可解释信号。

---

## 26. Resource / Quota 模型

Fleet 必须同时支持不同资源经济模型：

```text
Metered API
Token Plan
Credit Plan
Subscription / Plus / Pro
Rate Limit
Custom Budget
```

关键原则：

```text
Token != Cost != Quota
```

例如：

```text
Claude Code + DeepSeek profile
→ 可以按 Token / API price 计算 estimated cost
→ Provider 有真实账单接口时可记录 actual cost

Claude Code + MiniMax profile
→ 可以关联 Token Plan / quota snapshot

Codex CLI + subscription
→ 只有 Runtime / 官方来源可靠暴露额度时才展示 remaining percent
```

不知道订阅额度时必须显示 unavailable，不能从 Token 数量伪造“剩余百分比”。

Resource Account 与 Runtime 解耦：同一个 Claude Code Runtime 可以使用不同 Provider/Profile，因此资源、计费和额度逻辑不能写死进 RuntimeAdapter。

---

## 27. Metrics Engine：效率不是只看 Token

决策层应综合：

```text
Capability match
历史同类任务质量
历史同类任务速度
Time to first edit / commit / PR
PR cycle time
Token usage
Estimated / actual API cost
Current load
Context headroom
Remaining quota / budget
Quota reset time
Repo / Worktree conflict
Task priority / deadline
```

历史指标要按任务类型 / capability 分桶，不能因为一个 Agent 前端任务快，就推导它所有任务都快。

---

## 28. Recommendation / Strategy Layer

Strategy Engine 的候选对象既可以是现有 Instance，也可以是“新建一个 Instance 的 Launch Template”。

例如：

```text
A. Existing Claude #2 / DeepSeek
B. Launch Claude Code / MiniMax profile
C. Existing Codex #1
```

因此 UI 可以给出可解释建议：

```text
建议：再开一个 MiniMax Claude Code Worker

原因：
- 当前有 2 个无依赖任务可并行
- 现有 Worker 都在忙
- MiniMax quota 充足
- 历史同类任务耗时较短
- 避免继续增加 DeepSeek 按量 API 成本
```

Recommendation Panel 必须显示依据、数据来源和不确定项，不能只给一个黑盒分数。

Strategy 应通过可替换 `StrategyAdapter` 扩展，例如：

```text
balanced
fastest
lowest-cost
highest-quality
quota-preserving
custom
```

---

## 29. Coordinator 自动启动 / 分配 Agent

目标架构允许 Coordinator 根据任务清单和规则主动启动 Agent，但必须走 Fleet Control Plane。

权限模式：

```text
observe     只读
suggest     只建议
aapprove    请求执行，用户确认
autonomous  在预设边界内自动执行
```

实现时正式枚举应使用 `approve`（上面 `aapprove` 仅为文档排版错误禁止进入代码）。

默认推荐：

```text
suggest / approve
```

Coordinator 可以读取：

```text
Task List
Dependencies
Required Capabilities
Priority
Current Agents
Historical Metrics
Token / Cost / Quota
Mission Policy
```

然后通过 Fleet API / MCP：

```text
fleet.list_candidates()
fleet.get_resource_status()
fleet.recommend_assignment()
fleet.launch_instance()
fleet.assign_work_item()
fleet.get_metrics()
fleet.stop_instance()
```

`autonomous` 模式必须有硬限制：最大并发 Agent、最大按量成本、额度保留、允许 Runtime/Provider/Model、Repo 范围、Worktree 隔离、Review/Merge 规则。

未知额度不能视作无限额度。

---

## 30. 面向更多 Agent 的扩展边界

v1 实现 Claude Code CLI + Codex CLI，但核心接口必须允许后续接入：

```text
Gemini CLI
OpenCode
Qoder CLI
Custom Agent Runtime
```

扩展点分离：

```text
RuntimeAdapter       → CLI 生命周期 / Session / Runtime events
ResourceAdapter      → Token / Cost / Quota / Subscription
ObservabilityAdapter → 外部可测量工具 / runtime telemetry
SCMAdapter           → GitHub / GitLab / local Git
StrategyAdapter      → 任务分配策略
```

禁止让未来新增一个 Runtime 时同时重写 Mission、Ledger、Metrics、Strategy 和前端。

最终数据路径：

```text
Runtime Adapters
      ↓
FleetEvent
      ↓
Telemetry ─────┐
               ├→ Metrics Engine → Strategy → Recommendation / Coordinator
Fleet Ledger ──┘
      ↑
Resource / SCM / Quality Signals
```

详细设计见 [`FLEET_LEDGER_AND_SCHEDULING.md`](./FLEET_LEDGER_AND_SCHEDULING.md)。
