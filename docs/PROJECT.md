# PROJECT.md — Claude Fleet

> "我们在做什么"。  
> 系统形态见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；阶段规划见 [`ROADMAP.md`](./ROADMAP.md)。

---

## 项目背景

目前开发者想同时跑多个 Coding Agent，通常只能：

- 开多个终端 / 多个窗口，缺乏统一视图；
- 让所有 Agent 共享同一个 Repo、Provider、Model，除非手动隔离；
- 缺乏"现在每个 Agent 在做什么"的实时、低摩擦的可视化；
- 难以在同一个任务下对比不同 Agent 的做法。

结果就是：串行工作流、手工记账、并行 Agent 的信噪比极低。

---

## 项目愿景

Claude Fleet 提供一个 VS Code 工作区，让开发者（以及小型团队）可以**同时驱动多个
Coding Agent**，每个实例独立 Repo、独立 Provider、独立 Model、独立配置，并通过
**实时状态与 Pixel-style 可视化**同时看到所有 Agent 的工作进展。

---

## 要解决的问题

- 多 Agent 并行时缺乏统一管理面。
- Agent 之间默认共享 Repo / Provider / Model / 配置，容易相互污染。
- 缺乏"实时、低摩擦"的状态展示。
- 缺少在同一任务下横向对比多种 Coding Agent 的方式。

---

## 目标用户

- **主要用户**：已经在使用 Claude Code（或类似 Coding Agent）的独立开发者，希望
  在一个工作区内同时驱动多个 Agent 实例。
- **次要用户**：尝试多 Agent 工作流的小型团队，需要为每个 Agent 隔离 Repo / Provider / Model。

---

## 核心能力（规划方向）

第一阶段重点围绕 Claude Code：

- 同时管理多个 Claude Code 实例
- 每个实例绑定独立 Repo
- 每个实例独立 Provider
- 每个实例独立 Model
- 每个实例独立 Session 与配置环境
- 实时查看 Agent 状态与工作进度
- Pixel-style 可视化

后续阶段会扩展到 Codex、Gemini CLI、Antigravity 等其他 Coding Agent。

---

## 第一阶段范围（In Scope）

- VS Code Extension 作为宿主 UI 与控制面。
- 多实例 Claude Code 管理。
- 每个实例的 Repo / Provider / Model / Session 隔离。
- 实时状态与进度展示（文字优先）。
- Pixel-style 可视化骨架。

---

## 非目标（Non-Goals）

明确**不做**的事情，避免 scope creep：

- 云端多 Agent 编排（这是一个本地 / IDE 中心化工具）。
- 替换任何一个具体的 Coding Agent —— Claude Fleet **运行**它们，而不是**重新实现**它们。
- 自动合并或自动协调多 Agent 的输出（决策由人来做）。
- 除本地状态展示所必需的遥测以外的任何分析 / 埋点系统。

---

## 当前阶段

```
项目基础设施 / 文档系统 / Spec 设计阶段
```

- 文档系统（`AGENTS.md` / `docs/` / `.agent/` / `.claude/`）已建立。
- 公共 Agent 工作流（spec / implement / debug / review）已建立。
- 知识沉淀机制（lessons / pitfalls / decisions / 晋升规则）已建立。
- **尚未**编写任何业务代码。
- **尚未**启动任何 Feature Spec。

下一步进入 [`ROADMAP.md`](./ROADMAP.md) 中的 **Phase 1 — MVP Spec**。

---

## 待确认问题

> 以下问题需要在 Phase 1（MVP Spec）阶段确认。

- 多 Agent 实例的运行模型：子进程？VS Code workspace 连接？SDK 嵌入？
- 持久化状态存在哪里（VS Code `globalState`、本地 JSON/SQLite、不持久化）。
- Provider / Model / 环境隔离如何强制（独立进程 / 独立配置上下文 / 独立容器）。
- Pixel-style 可视化的具体形态，以及它如何映射到 Agent 状态。
- Coding Agent 运行时本身的调用方式：CLI、SDK，还是两者皆可。
- 未来加入 Codex / Gemini CLI / Antigravity 时，是走 Provider 抽象，还是更通用的
  Agent Adapter 层。

这些问题的答案将作为 ADRs 进入 `.agent/knowledge/decisions.md`。