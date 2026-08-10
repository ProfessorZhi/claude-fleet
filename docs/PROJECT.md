# PROJECT.md — Claude Fleet / Agent Fleet Direction

> “我们在做什么”。  
> 系统形态见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；阶段规划见 [`ROADMAP.md`](./ROADMAP.md)；资源、Ledger 与调度见 [`FLEET_LEDGER_AND_SCHEDULING.md`](./FLEET_LEDGER_AND_SCHEDULING.md)。

---

## 项目定位

Claude Fleet 当前是一个 VS Code Extension，用来统一管理多个 Claude Code CLI 实例。

目标已经明确扩展为：

> **统一管理 Claude Code CLI + Codex CLI 多实例，并逐步形成 Mission、Role、Coordinator、Observability、Fleet Ledger、Metrics 与 Policy Scheduling 的本地 Coding Agent Control Plane。**

当核心 Domain 和 Codex CLI 支持成熟后，产品计划迁移品牌为：

> **Agent Fleet — Local Control Plane for Coding Agents**

长期 Runtime 扩展方向包括 Gemini CLI、OpenCode、Qoder CLI 与自定义 Agent Runtime，但第一版正式 Managed Runtime 仍聚焦 Claude Code CLI + Codex CLI。

---

## 要解决的问题

今天开发者同时使用多个 Coding Agent 时，通常面临：

- 多个 Claude / Codex 终端散落在不同窗口；
- 很难一眼知道每个 Agent 正在做什么；
- Repo / Worktree / Session 容易混乱；
- 不同 Agent 的角色关系只能靠人脑记；
- 主线程与执行线程缺少统一组织方式；
- Claude Code Provider / Model 多实例配置容易相互污染；
- Agent 完成、等待、报错、调用工具等状态缺乏统一可视化；
- 不知道不同 Agent 实际花了多少时间、Token 和费用；
- 不知道某个 Agent 提了哪些 PR、质量和返工情况如何；
- 不同 Provider / Token Plan / Subscription 的剩余资源难以统一判断；
- 主线程缺乏数据来判断下一项任务应该给谁、是否值得再开一个 Agent；
- 多 Agent 协作时容易把聊天上下文当共享状态，导致不可追踪。

Fleet 的目标是把这些问题收敛到一个本地控制平面。

---

## 核心体验

一个开发任务被组织成一个 Mission：

```text
Mission: Fleet Scene Redesign

Coordinator
└── Codex CLI #1

Fleet
├── Claude Code #1 — Frontend Worker / DeepSeek
├── Claude Code #2 — Telemetry Worker / MiniMax
└── Codex CLI #2 — Reviewer
```

用户可以：

- 启动多个 Claude Code CLI；
- 启动多个 Codex CLI；
- 同时运行 Claude 与 Codex；
- 给实例指定 Coordinator / Worker / Reviewer / Debugger 角色；
- 选择任意 managed Claude/Codex Instance 作为 Mission Coordinator；
- 查看 Repo / Worktree / Session / Runtime / Status；
- 点击实例聚焦真实 Terminal；
- 查看近期工具调用、等待、错误、完成等 Telemetry；
- 查看每个 Task / Session / PR 的长期元信息；
- 查看 Token、API 成本、Token Plan / Subscription quota（有可靠来源时）；
- 查看 Time to PR、PR cycle、CI、Review、返工等效率与质量指标；
- 获得“用现有 Agent / 新开 Agent / 换资源账户 / 暂缓任务”的可解释建议；
- 在用户授权的 Policy 下，让 Coordinator 通过 Fleet Control API / MCP 请求或自动 Launch / Assign Agent；
- 在 Task Control Center、Fleet Command 与 Pixel Office Scene 之间切换。

---

## 当前现实工作流

当前仓库的成熟 Runtime 仍主要是 Claude Code CLI。

开发时可以使用：

```text
Codex Desktop / Client
→ 外部主线程 / Coordinator

VS Code + Claude Fleet
→ 多个 Claude Code CLI Worker
```

但这只是当前工作方式，不是架构限制。

目标完整工作流：

```text
VS Code + Fleet
├── Claude Code CLI
├── Claude Code CLI
├── Codex CLI
└── Codex CLI
```

其中任意一个 managed Instance 都可以承担 Coordinator。

Codex Desktop 继续可以作为可选 External Coordinator，但不是 Fleet 核心依赖。

---

## 核心产品原则

1. **Fleet 是 Control Plane，不是 Agent Runtime。** Fleet 管理原生 `claude` / `codex`，不重新实现它们。
2. **Runtime 与 Role 解耦。** 不写死 Codex=Coordinator、Claude=Worker。
3. **Repo 是共享真相，不是聊天历史。** `AGENTS.md`、`.agent/`、Specs、Git、Tests 是跨 Agent 协作基础。
4. **原生 Session 语义优先。** Resume、权限、工具尽量保持 Runtime 原生语义。
5. **Observability 必须来自真实信号。** 不知道的数据标记 unavailable，不猜。
6. **Telemetry 与 Ledger 分离。** 一个描述实时状态，一个保存长期元信息。
7. **Token、Cost、Quota 分离。** 按量 API、Token Plan、Plus/Pro/Subscription 不能混成一个指标。
8. **Recommendation 与 Execution 分离。** 先记录事实，再推荐；先推荐，再在 Policy 范围内自动执行。
9. **自动执行必须受预算和权限约束。** Unknown quota 不等于 Unlimited。
10. **本地优先、可扩展。** 核心 Domain 不依赖 Claude/Codex vendor-specific if/else。

---

## 第一版正式支持范围

### Managed Runtime

- Claude Code CLI
- Codex CLI

### Control Plane

- FleetInstance
- Mission
- Role
- Coordinator
- Repo / Worktree / Session
- Runtime lifecycle

### Claude Code 专属能力

- Provider Registry
- Provider Profile
- Model selection
- per-instance Provider / Model isolation
- SecretStorage
- native Resume / Provider switch continuity

### Observability

- Runtime-neutral FleetEvent
- FleetTelemetryStore
- Instance status
- Current tool / task（能可靠获取时）
- Recent Timeline
- Error state

### Ledger / Metrics 基础

- Task / Session / PR 元信息
- 时间成本
- Token / estimated/actual cost
- Quota snapshot（有可靠来源时）
- PR / CI / Review / Rework signals
- Assignment decision audit metadata

### Visualization

- Pixel Office 保留
- Fleet Command Pixel Sci-Fi Scene
- 点击实例 / Vessel 聚焦真实 Terminal
- Agent / Subagent / Team 行为尽量保持现有细节
- Telemetry / Ledger / Suggestions 使用现代 VS Code UI

---

## Coordinator 与自动调度方向

用户可以提供：

```text
Task List
Dependencies
Required Capabilities
Priority
Concurrency Rules
Cost / Quota Rules
Approval Policy
```

Coordinator 读取 Fleet 的候选 Agent、历史 Metrics 和资源状态后，可以：

```text
选择现有 Agent
建议新开 Agent
请求 Launch / Assign
在授权范围内自动 Launch / Assign
```

权限模式建议：

```text
observe
suggest
approve
autonomous
```

默认从 `suggest / approve` 开始；`autonomous` 必须有并发、预算、quota reserve、Runtime/Provider/Repo 等硬边界。

---

## Codex Desktop 的定位

Codex Desktop / Client 可以作为 External Coordinator，但不要求 Fleet：

- 自动创建 Codex Desktop Thread；
- 管理其所有 Thread；
- 嵌入聊天 UI；
- 读取完整聊天上下文。

执行线程优先使用可被 Fleet 管理和观测的 Claude Code CLI / Codex CLI。

---

## 扩展方向

长期通过 Adapter 扩展：

```text
RuntimeAdapter       → Claude / Codex / Gemini CLI / OpenCode / Qoder / Custom
ResourceAdapter      → API billing / token plan / subscription / custom quota
ObservabilityAdapter → 外部可测量工具
SCMAdapter           → GitHub / GitLab / local Git
StrategyAdapter      → speed / cost / quality / balanced / custom
```

新增 Runtime 不应该迫使 Mission、Ledger、Metrics、Strategy 和前端一起重写。

---

## 非目标

当前阶段明确不做：

- 云端分布式 Agent 集群；
- 重写 Claude Code 或 Codex；
- Agent-to-Agent 实时聊天总线；
- 无预算边界的自动 Agent 扩张；
- 自动替用户合并所有 Agent 输出；
- 依赖 Codex Desktop 私有接口；
- 一次支持所有 Coding Agent；
- 重型 3D / WebGL 舰队场景；
- 用聊天复制模拟 Session Resume。

---

## 品牌方向

当前：

```text
Claude Fleet
```

当 Claude Code + Codex CLI 达到稳定一等 Runtime 支持，且核心 Domain 已 Runtime-neutral 后：

```text
Agent Fleet
```

推荐最终描述：

> **Agent Fleet is a local control plane for launching, coordinating, observing and managing multiple coding-agent sessions.**

品牌迁移应作为独立阶段完成，并覆盖仓库、插件前端、Package、Commands、State migration、Docs 与 Assets，而不是只改 Logo。

---

## 当前状态与推进顺序

已完成 Claude Code Alpha 基础：多实例、Provider/Model Isolation、状态监控、最小控制 UI、Provider Registry、Session Continuity、Auto Discovery、Branding、Pixel UI 基线。

下一阶段按：

```text
Runtime-neutral model
→ Unified Observability
→ Codex CLI Adapter
→ Mission / Role / Coordinator
→ Fleet Ledger / Resource Accounting
→ PR / Quality Metrics
→ Recommendation
→ Fleet Command Scene
→ Control API / MCP + Policy Execution
→ Agent Fleet branding
→ More Runtime Adapters
```
