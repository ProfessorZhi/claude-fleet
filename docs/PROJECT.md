# PROJECT.md — Agent Fleet

> 产品目标、当前边界与用户价值。系统架构见
> [ARCHITECTURE.md](./ARCHITECTURE.md)，阶段推进见 [ROADMAP.md](./ROADMAP.md)，
> Ledger / 资源 / 指标 / 调度见
> [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md)。

## Canonical brand

当前正式品牌：

> **Agent Fleet — Local Control Plane for Coding Agents**

Claude Fleet 只允许出现在历史说明、Pixel Agents 迁移记录、旧 package / command /
config / state 兼容路径中。它不是未来品牌，也不是当前产品的并列名称。

当前仓库仍可能存在以下 legacy identifiers：

- GitHub 仓库与 package 名：claude-fleet；
- VS Code command / configuration namespace：claude-fleet.* / claudeFleet.*；
- 状态目录 ~/.claude-fleet/；
- ClaudeFleetViewProvider 等已发布 API / 类名；
- PIXEL_AGENTS_* 与旧 Pixel Agents 迁移兼容逻辑。

这些是兼容面，不改变产品的 canonical brand；本轮不重新实施一轮品牌迁移。

## 项目定位

Agent Fleet 是一个本地优先的 **Local Coding Agent Control Plane**。

它位于真实 Coding Agent Runtime 之上，负责：

- Runtime launch、stop、restart、resume 与 terminal lifecycle；
- Mission、WorkItem、Role、Coordinator 和 Instance 的组织；
- Repo / Worktree / Session 绑定与隔离；
- Provider / Model / Resource Account 关联；
- FleetEvent、Telemetry、Ledger、Metrics 与 Quality；
- Recommendation、Policy、Control API、可视化与 Terminal Focus。

它不重新实现：

- Claude Code；
- Codex CLI；
- Gemini CLI；
- OpenCode；
- Qoder CLI；
- 其他用户提供的 Coding Agent Runtime。

真实 Runtime 继续由原生 CLI 执行，例如 claude、codex。Agent Fleet 管理它们，
但不是它们的 Conversation Engine、TUI Emulator 或 SDK replacement。

## v1 Managed Runtime

v1 的一等 Fleet-managed Runtime 是：

```text
Claude Code CLI
Codex CLI
```

v1 允许：

```text
Claude Code × N
Codex CLI × N
Claude + Codex mixed fleet
```

核心原则：

> **Runtime != Role**

Runtime 表示“由谁执行”，Role 表示“在 Mission 中承担什么职责”。

```text
Runtime:
  claude-code
  codex-cli

Role:
  coordinator
  worker
  reviewer
  debugger
  planner
  tester
```

任意 managed Claude / Codex Instance 都可以担任 Coordinator。不能写死
“Codex = Coordinator、Claude = Worker”。

未来可通过 Adapter 接入：

```text
Gemini CLI
OpenCode
Qoder CLI
Custom Agent Runtime
```

## 当前实现与目标架构

当前仓库已经具备或正在具备：

- VS Code Extension 作为主要宿主；
- Claude Code 多实例 terminal lifecycle；
- Provider Registry / Provider Profile / SecretStorage；
- per-instance Provider / Model；
- native Session Resume、Restart、Switch Provider、New Session；
- Auto Discovery 与 Managed / External 基础区分；
- AgentState、Hook / JSONL 状态管线；
- Pixel Office 行为基线；
- agentmetrics/ Usage Ledger 与 Codex / Claude collector；
- Fleet identity、FleetInstance、Mission、WorkItem、RuntimeAdapter type contracts，以及初步
  FleetEvent / Telemetry projection。
- 当前 Claude Code 的 Host-owned launch/focus/stop lifecycle，以及 Host/Workspace/Terminal/
  launch-source metadata persistence。

仍属于目标架构、尚未在本轮实现：

- Codex CLI RuntimeAdapter；
- 通用 FleetRuntimeHost 生命周期与多 Host 解析（当前已有 Claude/VS Code Integrated Terminal 薄封装）；
- Mission / WorkItem durable lifecycle；
- Fleet Ledger durable store；
- ResourceAdapter、SCMAdapter、StrategyAdapter；
- Metrics Engine、Recommendation；
- Fleet Control API / MCP；
- Instance Detail、Terminal Dock；
- Policy-controlled scheduling；
- autonomous execution。

目标架构必须建立在当前实现之上，不能因为目标模型存在就假装这些模块已经可用。

## Mission 作为顶层工作单元

一个开发目标组织成 Mission：

```text
Mission: Agent Fleet Runtime Host

Coordinator
└── Codex CLI #1

Workers
├── Claude Code #2 · Frontend
├── Claude Code #3 · Runtime Host
└── Codex CLI #4 · Tests

Reviewer
└── Codex CLI #5
```

Mission 是：

- 任务组织边界；
- Repo / Worktree 隔离边界；
- 资源与额度统计边界；
- Telemetry 聚合边界；
- Ledger 与调度边界。

第一版 Mission 只需要成为组织和可观测边界，不意味着本轮实现自动规划器、
自动任务分解或 Agent-to-Agent Chat Bus。

## 目标用户体验

用户可以在一个管理面看到：

- 哪个 Mission 正在进行；
- 哪个 Instance 使用哪个 Runtime、Role、Provider、Model 和 Resource Account；
- Instance 绑定的 Repo、Worktree、Session 和 VS Code Host；
- 当前状态、Current Tool、Current Task、最近 FleetEvent；
- Token、Cost、Quota 的来源和可靠性；
- PR、CI、Review、返工和质量信号；
- Coordinator 的 Assignment / Launch Recommendation；
- Focus Terminal、Restart、Stop 等真实 Runtime 操作。

点击 Agent / Vessel 的默认行为是打开 Instance Detail；只有点击
**Focus Terminal** 才切换到真实 VS Code Integrated Terminal。

## 当前运行拓扑

当前代码事实仍是 Claude-first：

```text
Codex Desktop / Client
  external coordinator
        │
        │ Git / Spec / tasks / commits / diffs / tests
        ▼
Agent Fleet in VS Code
  ├── Claude Code CLI instance A
  ├── Claude Code CLI instance B
  └── Claude Code CLI instance N
```

当前 Codex Desktop 不是 Fleet-managed Runtime。它不会被 Fleet 当作 terminal instance、
scene vessel 或 lifecycle owner。

v1 目标拓扑是：

```text
External or Managed Coordinator
        │
        ▼
Agent Fleet Control Plane / API
        │
        ▼
Mission Policy → Strategy → Resource Check
        │
        ▼
FleetRuntimeHost → VS Code Integrated Terminal
        │
        ▼
RuntimeAdapter → native Claude / Codex CLI
```

## Repository as source of truth

Agent 之间的主要共享状态是仓库事实：

```text
AGENTS.md
docs/specs/
.agent/
Mission task list
Git branches / worktrees
commits / diffs
tests / CI
PR / review notes
```

不要复制完整 Prompt、完整 Transcript 或聊天全文作为主要协作协议。Telemetry /
Ledger 也只保存必要的结构化 metadata，不保存 Secret 或默认保存完整对话。

## 观测、资源与策略的分层

```text
Runtime signals
      ↓
RuntimeAdapter / ObservabilityAdapter
      ↓
FleetEvent
      ├── FleetTelemetryStore  (实时、有界)
      └── Fleet Ledger         (长期、可查询)
                                  ↓
                       Metrics / Resource / SCM / Quality
                                  ↓
                              Strategy
                                  ↓
                         Recommendation
                                  ↓
                       Control API / Policy
```

必须保持：

```text
Telemetry != Ledger
Token != Cost != Quota
Runtime != ResourceAccount
Recommendation != Execution
Runtime != Role
```

未知信息必须显示 unknown / unavailable，不能猜测或把未知额度当作无限。

## 当前阶段

当前工作优先级：

1. 稳定 Claude Code Runtime 与 Provider / Session 兼容性；
2. 建立 Runtime-neutral Domain 和 FleetRuntimeHost 边界；
3. 统一 Claude / Codex 的 FleetEvent 与 Usage 关联；
4. 再逐步实现 Mission、Ledger、Metrics、Recommendation 和 Policy Control。

本轮只更新文档与 ADR，不实现新的 Runtime、Scheduler、MCP、数据库或 UI。

## Explicit non-goals

本轮明确不做：

- Codex Runtime Adapter；
- FleetRuntimeHost；
- Fleet Control API / MCP Server；
- Strategy Engine；
- Ledger 数据库；
- 自动 Agent Scheduler；
- Instance Detail / Terminal Dock UI；
- 新的 Provider API 集成；
- 真实模型 API 调用；
- VSIX、Release 或 Marketplace 发布。
