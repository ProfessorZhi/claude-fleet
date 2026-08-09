# PROJECT.md — Claude Fleet / Agent Fleet Direction

> “我们在做什么”。  
> 系统形态见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；阶段规划见 [`ROADMAP.md`](./ROADMAP.md)。

---

## 项目定位

Claude Fleet 当前是一个 VS Code Extension，用来统一管理多个 Claude Code CLI 实例。

v1 目标已经明确扩展为：

> **统一管理 Claude Code CLI + Codex CLI 多实例，并提供 Mission、Role、Coordinator、Telemetry 与可视化控制平面。**

当 Codex CLI 达到一等支持后，产品计划迁移品牌为：

> **Agent Fleet — Local Control Plane for Coding Agents**

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
- 多 Agent 协作时容易把聊天上下文当共享状态，导致不可追踪。

Fleet 的目标是把这些问题收敛到一个本地控制平面。

---

## v1 核心体验

一个开发任务被组织成一个 Mission：

```text
Mission: Fleet Scene Redesign

Coordinator
└── Codex CLI #1

Fleet
├── Claude Code #1 — Frontend Worker
├── Claude Code #2 — Telemetry Worker
└── Codex CLI #2 — Reviewer
```

用户可以在 VS Code 中：

- 启动多个 Claude Code CLI；
- 启动多个 Codex CLI；
- 同时运行 Claude 与 Codex；
- 给实例指定 Coordinator / Worker / Reviewer / Debugger 角色；
- 选择任意 managed Claude/Codex Instance 作为 Mission Coordinator；
- 查看每个实例的 Repo / Worktree / Session / Runtime / Status；
- 点击实例聚焦真实 Terminal；
- 查看近期工具调用、等待、错误、完成等 Telemetry；
- 在 Pixel Office 与新的 Fleet Command Scene 之间切换。

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

但这只是当前工作方式，不是 v1 架构限制。

v1 的目标是把 Codex CLI 也纳入 Fleet，使最完整工作流变成：

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

### 1. Fleet 是 Control Plane，不是 Agent Runtime

Fleet 启动和管理原生：

```text
claude
codex
```

不重新实现它们。

### 2. Runtime 与 Role 解耦

不要写死：

```text
Codex = Coordinator
Claude = Worker
```

而是：

```text
Runtime: Claude Code / Codex CLI
Role: Coordinator / Worker / Reviewer / Debugger
```

### 3. Repo 是共享真相，不是聊天历史

Agent 协作优先通过：

```text
AGENTS.md
.agent/
docs/specs/
Git branches / worktrees
commits
diffs
tests
```

### 4. 原生 Session 语义优先

Claude Code / Codex 的 Resume、Session、权限与工具能力尽量保持原生语义。

### 5. Observability 必须来自真实信号

不知道的数据标记 unavailable，不猜。

### 6. 本地优先

核心能力不依赖云端 Fleet 服务。

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

### Visualization

- Pixel Office 保留
- Fleet Command Pixel Sci-Fi Scene
- 点击实例 / Vessel 聚焦真实 Terminal
- Agent / Subagent / Team 行为尽量保持现有细节

---

## Codex Desktop 的定位

Codex Desktop / Client 可以作为：

```text
External Coordinator
```

但 v1 不要求：

- Fleet 自动创建 Codex Desktop Thread；
- Fleet 管理 Codex Desktop 内所有 Thread；
- Fleet 嵌入 Codex Desktop 聊天 UI；
- Fleet 读取其完整聊天上下文。

执行线程优先使用可被 Fleet 管理和观测的 Claude Code CLI / Codex CLI。

---

## 非目标

v1 明确不做：

- 云端分布式 Agent 集群；
- 重写 Claude Code 或 Codex；
- Agent-to-Agent 实时聊天总线；
- 自动 DAG Scheduler；
- 自动替用户合并所有 Agent 输出；
- 依赖 Codex Desktop 私有接口；
- 一次支持所有 Coding Agent；
- 重型 3D / WebGL 舰队场景；
- 完整 Jaeger / Grafana 类 tracing 平台；
- 用聊天复制模拟 Session Resume。

---

## 品牌方向

当前：

```text
Claude Fleet
```

当 Claude Code + Codex CLI 都达到稳定一等 Runtime 支持后：

```text
Agent Fleet
```

推荐最终描述：

> **Agent Fleet is a local control plane for launching, coordinating, observing and managing multiple coding-agent sessions.**

品牌迁移应作为独立阶段完成，避免 Runtime 重构过程中一半 Claude Fleet、一半 Agent Fleet。

---

## 当前状态

当前仓库已经不是“纯文档阶段”。

已完成的 Claude Code Alpha 基础包括：

- 多实例 Runtime；
- Provider / Model Isolation；
- 状态监控；
- 最小控制 UI；
- Provider Registry；
- Session Continuity；
- Auto Discovery；
- Claude Fleet Branding；
- Pixel Agents 可视化基线。

下一阶段围绕 v1 目标推进：

```text
Runtime-neutral model
→ Mission / Role
→ Observability
→ Codex CLI Adapter
→ Claude + Codex mixed fleet
→ Fleet Command Scene
→ Agent Fleet branding
```
