# ROADMAP.md — Claude Fleet → Agent Fleet

> 阶段推进按 Exit Criteria，而不是日历日期。  
> 产品定位见 [`PROJECT.md`](./PROJECT.md)；目标架构见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

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

# v1 目标

> **Claude Code CLI + Codex CLI 的统一多实例管理。**

v1 不是“Claude Code 管理器再加一个 Codex 按钮”，而是形成真正 Runtime-neutral 的 Fleet Control Plane：

```text
Mission
└── Coordinator
    ├── Claude Code CLI
    └── Codex CLI

Fleet Instances
├── Claude Code CLI × N
└── Codex CLI × N
```

Runtime 与 Role 解耦：

```text
Runtime = Claude Code | Codex CLI
Role    = Coordinator | Worker | Reviewer | Debugger
```

---

## Phase A — Stabilize Existing Claude Runtime

**目标**：先保证现有 Claude Code 能作为未来 Runtime Adapter 的稳定基线。

主要工作：

- Development Host 真人测试；
- 修复 Claude CLI executable discovery；
- 修复 `.vscode/launch.json` / `tasks.json`；
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
- 不实现自动 DAG Scheduler。

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

**目标**：建立 Runtime-neutral 的状态与可观测边界。

数据路径：

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
- current tool（可靠时）；
- current task（可靠时）；
- session / runtime / role / repo；
- recent events；
- errors；
- bounded timeline。

**非目标**：完整 tracing 平台。

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
- Launch；
- Stop；
- Focus；
- Repo / cwd / Worktree 绑定；
- Session identity；
- Restart / Resume（严格按 Codex 原生能力）；
- Status / Telemetry adapter；
- Auto Discovery（仅在有可靠机制时）；
- mixed-runtime tests。

禁止：

- 假设 Codex 与 Claude 有完全相同 Session / Provider 参数；
- 通过不稳定猜测伪造 Codex status；
- 把 Codex Desktop 私有 Thread 当 CLI Runtime。

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

**目标**：让多实例不只是“终端列表”，而是一个有主线程和角色关系的工作单元。

示例：

```text
Mission: Implement Fleet Command

Coordinator
└── Codex CLI #1

Workers
├── Claude Code #1 — Frontend
├── Claude Code #2 — Telemetry
└── Codex CLI #2 — Review
```

支持：

- Mission create/select；
- Role assignment；
- 任意 managed Claude/Codex Instance 设置为 Coordinator；
- Coordinator 卡片；
- Worker / Reviewer 展示；
- Repo / Worktree 风险提示；
- Handoff / recent events 展示。

Codex Desktop 可以作为 optional External Coordinator，但不作为 v1 核心能力依赖。

**Exit Criteria**：

```text
[ ] Claude Instance 可当 Coordinator
[ ] Codex Instance 可当 Coordinator
[ ] 更换 Coordinator 不重建 Runtime
[ ] Mission 与 Role 不依赖 Runtime 类型
[ ] External Coordinator 不影响 managed-only 完整工作流
```

---

## Phase F — Fleet Command Scene

**目标**：从 Pixel Office 扩展出真正符合 Fleet 品牌的 Pixel Sci-Fi Scene，同时保留 Pixel Agents 的行为细节。

Scene 架构：

```text
Runtime / Telemetry
       ↓
    Scene Model
       ↓
├── Fleet Command
└── Pixel Office
```

Fleet Command 重点：

- Agent Instance → Vessel；
- Coordinator → Flagship；
- Worker → Frigate；
- Reviewer → Recon Vessel；
- Subagent → Drone；
- Working / Waiting / Error / Completion 等都有真实状态动画；
- 点击 Vessel → 选择对应 Instance；
- Focus → 真实 CLI Terminal；
- Telemetry / Detail Panel 使用现代 VS Code UI；
- Pixel Office 保持可切换。

**Exit Criteria**：

```text
[ ] Fleet Command 是默认 Scene
[ ] Pixel Office 仍完整可用
[ ] Scene 切换不影响 Runtime
[ ] Claude / Codex Vessel 都映射真实 Instance
[ ] 现有 Pixel Agent 关键行为有舰队对应表现
[ ] Subagent / Team 行为基于真实事件
```

---

## Phase G — Agent Fleet Brand Migration

**触发条件**：Claude Code CLI + Codex CLI 都已经达到稳定一等 Runtime 支持。

迁移：

```text
Claude Fleet → Agent Fleet
```

建议最终：

```text
Product: Agent Fleet
Repository: agent-fleet
Tagline: Local Control Plane for Coding Agents
```

代码 / 状态迁移可能包括：

```text
ClaudeFleetViewProvider → AgentFleetViewProvider
CLAUDE_FLEET_DEBUG      → AGENT_FLEET_DEBUG
~/.claude-fleet         → ~/.agent-fleet
```

必须保留兼容迁移和 Pixel Agents attribution。

不要在 Phase B-D 中零散做半套改名。

---

# v1 之后

只有 v1 多实例控制平面稳定后，再考虑：

- Fleet MCP Server；
- Coordinator 主动 launch / assign / query Agent；
- Task DAG；
- 更强 Worktree automation；
- Tactical Radar Scene；
- 更多 Coding Agent Runtime。

这些不是 v1 的前置条件。

---

# v1 最终 Exit Criteria

```text
[ ] Claude Code CLI × N
[ ] Codex CLI × N
[ ] Claude + Codex mixed fleet
[ ] Repo / Worktree / Session isolation
[ ] Mission
[ ] Runtime-neutral Role
[ ] Any managed Claude/Codex can be Coordinator
[ ] Unified FleetEvent / Telemetry
[ ] Real terminal Focus / lifecycle control
[ ] Claude Provider/Profile capability preserved
[ ] Fleet Command + Pixel Office switchable scenes
[ ] No secrets in telemetry
[ ] Git/spec/tasks remain collaboration source of truth
```
