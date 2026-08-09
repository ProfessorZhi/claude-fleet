# AGENTS.md — Claude Fleet

> **所有 Coding Agent（Claude Code、Codex、Gemini CLI、Antigravity 等）请从这里开始。**
>
> 本文件是 **Agent-neutral** 的：只放稳定规则、导航与核心原则。
> 更细的工作流、经验、知识沉淀放在 `.agent/`；项目自身的信息放在 `docs/`。

---

## 项目使命（Project Mission）

Claude Fleet 是一个本地优先的 **Coding Agent Control Plane**：在同一套 Fleet 状态下
协调 Claude Code、Codex 及未来其他 Agent，让每个 Worker 拥有独立的 Repo、Worktree、
Provider、Model、Session 和 Usage 记录，并在 Codex Management Cockpit 与 VS Code
Engineering Cockpit 中呈现同一份事实。

长期愿景：**一个工作区，一支可观测、可接管、可调度的 Agent Fleet。**

Claude Code 仍是当前 Runtime 基线；Codex Coordinator、agentmetrics、Fleet Telemetry
和 Fleet Command Scene 是后续扩展方向。

---

## 文档地图（Documentation Map）

整个项目的知识体系分为四层：

| 层          | 路径                     | 作用                                                                          |
| ----------- | ------------------------ | ----------------------------------------------------------------------------- |
| Agent 入口  | `AGENTS.md`              | 所有 Coding Agent 的统一入口；只放稳定规则、导航、核心原则（本文）            |
| Vendor 入口 | `CLAUDE.md` / `CODEX.md` | Claude Code / Codex 的薄适配层，不复制公共知识                                |
| 项目信息    | `docs/`                  | 描述"我们在做什么"：项目背景、架构、Roadmap、Feature Spec                     |
| Agent 行为  | `.agent/`                | 描述"Agent 应该怎么做"：工作流、经验、参考、模板、脚本                        |
| Claude 适配 | `.claude/`               | Claude Code 专属的薄适配层（skills、rules）。**不要**在这里复制第二份公共知识 |
| Codex 适配  | `.codex/`                | Codex 专属的薄适配层；公共规则仍在 `AGENTS.md` / `.agent/`                    |
| 观测子系统  | `agentmetrics/`          | Python Usage Ledger、Codex/Claude collectors、quota/pricing、runner           |

新 Agent 接到任何任务时的阅读顺序：

1. `AGENTS.md`（本文）
2. `docs/PROJECT.md` —— 我们要做什么
3. `docs/ARCHITECTURE.md` —— 当前架构理解
4. `docs/ROADMAP.md` —— 当前阶段与下一步
5. `docs/specs/<feature>/` —— 与当前任务相关的 Spec
6. `.agent/workflows/` —— 当前任务类型对应的工作流（含 `handoff.md`：跨 Agent / 跨 Session 交接）
7. `.agent/knowledge/` —— 已经沉淀的 lessons / pitfalls / decisions

如果当前运行时是 Claude Code，再读 `CLAUDE.md` 与相关 `.claude/` 文件；如果当前角色是
Codex Coordinator，再读 `CODEX.md`、`docs/COORDINATOR_WORKFLOW.md` 和
`.agent/workflows/coordinator-fleet-collaboration.md`。

---

## 必须遵守的开发流程

```
理解
 ↓
Spec
 ↓
Plan
 ↓
Implement
 ↓
Validate
 ↓
Review
 ↓
Learn
```

| 步骤          | 含义                                                      |
| ------------- | --------------------------------------------------------- |
| **理解**      | 先读相关 Spec / docs / 现有代码，不要靠假设工作           |
| **Spec**      | 如果没有 Spec，先在 `docs/specs/` 下补一份，再开始动手    |
| **Plan**      | 明确"最小正确改动是什么"以及"如何验证它"                  |
| **Implement** | 实施。优先选最小、最正确的版本                            |
| **Validate**  | 跑测试、复现场景，证明改动真的有效                        |
| **Review**    | 检查 Spec 符合度、正确性、Regression 风险、架构与文档影响 |
| **Learn**     | 如果产出了可复用经验，按下面的晋升规则沉淀                |

硬性要求：

- **开发功能前必须阅读相关 Spec。** 没有 Spec 的功能不应直接开始。
- **不清楚需求时先补 Spec，不要直接猜测实现。**
- **修改架构必须同步更新架构文档。** 一旦系统形态发生变化，更新 `docs/ARCHITECTURE.md`；
  必要时在 `.agent/knowledge/decisions.md` 增加一条 ADR。
- **Debug 必须尽量定位 Root Cause。** 禁止随机修改代码、禁止只贴 workaround。
- **Bug 修复尽量增加 Regression Test。**
- **有复用价值的经验必须沉淀到 `.agent/knowledge/`。**
- **不要把所有经验直接塞进 `AGENTS.md`。** 本文只放"每次任务都必须遵守"的稳定原则。
- **优先解决根因，而不是不断堆 workaround。**
- **公共文档保持 Agent-neutral。** 不依赖某一家 Coding Agent 的术语或行为。
- **不依赖某一次聊天上下文作为项目唯一知识来源。** 所有关键结论都要落到仓库里的文件。
- **跨 Agent / 跨 Session 交接不得依赖聊天上下文。** 必须通过 Spec、`tasks.md`、
  Git 与仓库文档留下可恢复状态。完整流程见 `.agent/workflows/handoff.md`。

---

## 知识沉淀规则

```
普通经验            → .agent/knowledge/lessons.md
高风险坑            → .agent/knowledge/pitfalls.md
架构选择            → .agent/knowledge/decisions.md
重复使用的解决流程  → .agent/workflows/
确定性规则          → scripts / tests / CI
所有 Agent 每次都必须知道的稳定原则 → AGENTS.md
```

完整说明见 `.agent/workflows/debug.md` 与 `.agent/workflows/review.md`。

原则：

> "以后不再复现"不能只依赖文档和 Agent 记忆。
> 优先级应该是：**Regression Test / Script > Workflow > Knowledge > 临时聊天记录**。

---

## 核心工程原则

1. **Spec 先于代码。** 非平凡改动先写或更新 Spec。
2. **最小正确改动。** 抵制 scope creep，做"最小且正确"的版本。
3. **根因优于 workaround。** 不能解释 _为什么_ 出问题，就不算修好。
4. **证据优于观点。** 先复现、日志、测量，再动手。
5. **知识会复利。** 每一个被解决的问题都是潜在的 lesson —— 主动晋升。
6. **分层文档，不重复。** `AGENTS.md` 是索引，不是百科全书。
7. **默认 Agent-neutral。** 工具相关的特性只放在 `.claude/` 或对应 vendor 目录。
8. **Handoff 走仓库，不走聊天。** Agent 之间交接的事实必须能被下一个 Agent 凭仓库
   状态复原。具体流程在 `.agent/workflows/handoff.md`，**不要**在这里复制全文。
9. **单一事实源。** Controller/Fleet state 是唯一事实源；Codex、VS Code、Webview 和
   未来其他界面只能做 Projection，不能各自维护 Agent 状态。
10. **遥测先规范化。** Claude Hook、Claude JSONL、Codex JSONL 和 agentmetrics 先转成
    FleetEvent，再交给 UI、评分和调度层消费。
