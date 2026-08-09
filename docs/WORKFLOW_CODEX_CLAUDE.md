# WORKFLOW_CODEX_CLAUDE.md — Codex + Claude Code Multi-Agent Workflow

> 本文定义 Claude Fleet / future Agent Fleet 的推荐多 Agent 工作方式。  
> 它描述**协作协议与职责边界**，不是自动 Orchestrator 实现说明。

---

## 1. 当前推荐工作方式

当前最成熟的实际组合：

```text
Codex Desktop / Client
→ External Coordinator / primary thread

VS Code + Claude Fleet
→ Claude Code CLI Workers
```

当前 Codex Desktop 负责：

- 需求澄清；
- 架构讨论；
- Spec / Plan；
- Review；
- 汇总各 Worker 结果。

Claude Code CLI Workers 负责：

- 按 Spec 实现；
- Debug；
- Tests；
- 小范围重构；
- 提交 Git commits。

---

## 2. v1 目标工作方式

v1 中 Codex CLI 也成为 Fleet-managed Runtime：

```text
Mission
│
├── Coordinator
│   └── Claude Code CLI or Codex CLI
│
├── Worker
│   └── Claude Code CLI or Codex CLI
│
├── Reviewer
│   └── Claude Code CLI or Codex CLI
│
└── Debugger
    └── Claude Code CLI or Codex CLI
```

Runtime 与 Role 解耦。

不要预设：

```text
Codex 永远是主线程
Claude 永远是 Worker
```

---

## 3. Mission

一次相对独立的开发目标建议对应一个 Mission。

例如：

```text
Mission: Add Codex Runtime Adapter

Coordinator
└── Codex CLI #1

Workers
├── Claude Code #1 — Runtime abstraction
├── Claude Code #2 — Codex adapter
└── Codex CLI #2 — Review / tests
```

Mission 应关联：

```text
Goal
Repo
Coordinator
Instances
Roles
Spec
Branches / Worktrees
```

第一版不要自动拆任务。

---

## 4. Repository as Source of Truth

Agent 之间的共享状态优先落在仓库，而不是聊天上下文。

核心共享载体：

```text
AGENTS.md
CLAUDE.md / runtime-specific thin adapters
.agent/
docs/specs/<feature>/requirements.md
docs/specs/<feature>/design.md
docs/specs/<feature>/tasks.md
Git branches / worktrees
commits
diffs
tests
review notes
```

推荐原则：

> Chat 用于当前 Agent 思考；Repository artifacts 用于跨 Agent 协作。

不要默认把 Worker A 的全部聊天历史复制给 Worker B。

---

## 5. 推荐工作循环

```text
Understand
→ Spec
→ Plan
→ Implement
→ Validate
→ Review
→ Fix
→ Merge
→ Learn
```

### Understand

Coordinator 明确：

- 目标；
- 非目标；
- 现有代码事实；
- 风险；
- 哪些工作可以并行。

### Spec

对于较大 Feature：

```text
docs/specs/XXX-feature/
├── requirements.md
├── design.md
└── tasks.md
```

### Plan

给不同 Worker 分配不重叠的代码区域 / Worktree。

### Implement

Worker：

- 先读 AGENTS.md / Spec / 当前 Git；
- 只实现自己的任务；
- 运行相关测试；
- 提交独立 commit。

### Validate

优先自动测试和确定性验证。

### Review

Reviewer 基于：

```text
Spec
commit
diff
tests
```

而不是基于 Worker 自述。

### Fix

由原 Worker 或独立 Fixer 修复 Review findings。

### Merge

Coordinator / 人类决定集成顺序。

### Learn

稳定经验进入：

```text
.agent/knowledge/
.agent/workflows/
ADRs
```

---

## 6. 并行开发必须使用 Branch / Worktree 边界

不要让两个 Coding Agent 同时修改同一个 `main` checkout。

推荐：

```text
main
│
├── worktree feat/runtime-model
│   └── Claude Code #1
│
├── worktree feat/codex-adapter
│   └── Codex CLI #1
│
└── worktree feat/fleet-scene
    └── Claude Code #2
```

如果任务不可真正并行，就串行执行，不要为了“Agent 集群”强行并行。

---

## 7. Coordinator 的职责

Coordinator 负责：

- 保持 Mission 目标；
- 维护 Spec 与 Task 状态；
- 分配 Worker；
- 避免编辑范围重叠；
- 检查 Git 状态；
- 汇总测试 / Review；
- 决定是否 Merge；
- 发现需要重新规划时更新 Spec。

Coordinator 不应该：

- 微观控制 Worker 的每一步工具调用；
- 把所有 Worker 的聊天历史拼起来；
- 在没有检查 Git diff 的情况下相信“已完成”；
- 自动覆盖其他 Worker 的 checkout。

---

## 8. Worker 的职责

Worker 启动后先恢复仓库事实：

```bash
git status -sb
git diff
git log --oneline -10
```

然后阅读：

```text
AGENTS.md
相关 Spec
相关代码
相关 tests
```

完成后必须提供：

```text
Changed files
Tests run
Test result
Commit SHA
Known limitations
```

不要把“聊天记得什么”当作 source of truth。

---

## 9. Reviewer 的职责

Reviewer 重点检查：

```text
requirements 是否满足
design 是否被遵守
是否破坏既有 Runtime
错误路径
Session continuity
Repo / Worktree isolation
Secret handling
Telemetry correctness
tests
```

Review 输出应具体到：

```text
file
symbol / line
problem
impact
recommended fix
```

---

## 10. Codex Desktop 的位置

Codex Desktop 可以继续作为方便的外部主线程。

适合：

- 长程架构讨论；
- 人机共同决策；
- 汇总结果；
- 临时 research / brainstorm。

但不推荐为了 Fleet Worker 数量，在 Codex Desktop 内创建大量 Worker Threads。

真正需要：

```text
lifecycle
cwd
Repo
Worktree
Session
status
telemetry
Focus / Stop / Restart
```

的执行线程优先使用 CLI Runtime。

---

## 11. Fleet UI 中的工作流映射

推荐 UI：

```text
Mission
├── Coordinator Card
├── Fleet Scene
│   ├── Worker Vessel
│   ├── Reviewer Vessel
│   └── Debugger Vessel
├── Telemetry Detail
└── Recent Timeline
```

Coordinator 是 managed CLI 时：

```text
[Focus Terminal]
```

Coordinator 是 Codex Desktop external thread 时：

```text
External Coordinator
```

只展示 Fleet 能可靠获取的 metadata。

---

## 12. Handoff

Handoff 不依赖专用 Chat Bus。

推荐最小 handoff package：

```text
Mission
Task ID
Spec path
Branch / Worktree
Base commit
Worker commit
Tests
Remaining issues
```

例如：

```text
Task: 007-03
Spec: docs/specs/007-runtime-control-plane/tasks.md
Branch: feat/runtime-model
Commit: abc1234
Tests: npm test -- runtimeModel
Remaining: Codex resume capability not implemented
```

另一个 Agent 可以仅凭仓库恢复工作。

---

## 13. v1 不实现的协作机制

当前不要实现：

```text
Agent-to-Agent WebSocket Chat
自动把聊天上下文广播给所有 Agent
自动 DAG Scheduler
自动 merge bot
自动 Coordinator election
LLM 自治集群
```

v1 重点是：

> **可靠管理 + 清晰角色 + Repo source of truth + 可观测。**

---

## 14. 后续 Fleet MCP

未来可以让 Coordinator 通过 MCP 调 Fleet Control Plane：

```text
fleet.list_instances()
fleet.launch_instance()
fleet.assign_task()
fleet.get_status()
fleet.get_recent_events()
fleet.stop_instance()
```

届时可以形成：

```text
Coordinator Agent
      │
      │ MCP
      ▼
Agent Fleet Control Plane
      │
      ├── Claude Code CLI
      ├── Codex CLI
      └── ...
```

但这是 v1 之后的自动化增强，不阻塞当前多实例架构。

---

## 15. 推荐日常模板

### 小任务

```text
Coordinator / Human
└── 1 Worker
```

不要过度多 Agent。

### 中等 Feature

```text
Coordinator
├── Implementer
└── Reviewer
```

### 可并行 Feature

```text
Coordinator
├── Worker A — isolated worktree
├── Worker B — isolated worktree
└── Reviewer
```

### 复杂 Feature

```text
Coordinator
├── Runtime Worker
├── Frontend Worker
├── Tests / Debug Worker
└── Reviewer
```

只有独立边界明确时才增加 Instance。
