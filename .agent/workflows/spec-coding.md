# Workflow — Spec Coding

> **何时使用**：开始任何非平凡的 Feature 之前。  
> 这是从"想法"到"任务列表"的规范流程。

---

## 目的

把一个想法变成一份**小、清晰、可被实现**的 Feature Spec，让实现、验证、Review 都有
明确的可指对象。

没有 Spec 的功能，不应该开始写代码。

---

## 流程

```text
Idea
 ↓
Requirements
 ↓
Design
 ↓
Tasks
 ↓
Implementation
```

每一阶段都有明确产物。不要跳过任何一阶段。在前三阶段产物存在之前，不要开始
Implementation。

### 1. Idea

- 用户层面发生了什么变化？
- 它为什么存在？解决什么问题？
- 仍然有用的最小版本是什么？

**产物**：一段话、甚至一两段。非正式即可。

### 2. Requirements

写 `docs/specs/<feature-slug>/requirements.md`：

- **目标（Goal）**：一句话。
- **用户故事（User Stories）**：谁在什么场景下做什么、为什么。
- **功能性需求（Functional Requirements）**：功能必须做什么。
- **非功能性需求（Non-Functional Requirements）**：性能、隔离、可靠性等。
- **不在范围内（Out of Scope）**：本 Feature 明确不做的事。
- **开放问题（Open Questions）**：阻塞 Design 的任何点。

### 3. Design

写 `docs/specs/<feature-slug>/design.md`：

- **Context**：链接 `requirements.md` 和相关 ADR。
- **高层形态**：组件草图或示意图。
- **模块职责**：每一块负责什么。
- **数据 / 状态形态**：状态是什么，存在哪里，谁拥有。
- **接口（Interfaces）**：公开边界（函数、消息、事件、UI 入口）。
- **失败模式（Failure Modes）**：可能出错的地方，以及系统的应对行为。
- **取舍（Trade-offs）**：考虑过的替代方案，以及为什么最终选了当前设计。

### 4. Tasks

写 `docs/specs/<feature-slug>/tasks.md`：

- 有序、可验证、足够小。每个 Task 应能在一次专注工作中完成。
- 每个 Task 应引用 `design.md` 中它实现的章节。
- 如有需要可分组，但默认按线性顺序排列。

### 5. Implementation

- 按 `tasks.md` 顺序执行。
- 每个 Task 走 `.agent/workflows/implement.md`。
- 任务完成时在 `tasks.md` 中打勾，**不要删除条目**。

---

## 目录布局

每个 Feature Spec 一律放在：

```text
docs/specs/<feature-slug>/
├── requirements.md
├── design.md
└── tasks.md
```

具体约定见 `docs/specs/README.md`。

---

## 反模式

- **边实现边设计。** 如果 `design.md` 缺少代码需要的章节，停下来补上，而不是
  隐式地把设计写在代码里。
- **"我们之后补 Spec。"** 不行。先 Spec，再代码。
- **巨型 Spec。** 把大 Feature 拆开。每个 slug 应该是内聚的。
- **Spec 与代码脱节。** 设计在 build 过程中变化时，先更新 `design.md`，再让代码跟上。
  Spec 与代码不一致，比没有 Spec 更糟。

---

## 移交

Spec 完成后进入实现：

- `.agent/workflows/implement.md` —— 执行 Task。
- `.agent/workflows/review.md` —— 实现完成后 Review。
- `.agent/workflows/debug.md` —— 实现过程中出错时使用。