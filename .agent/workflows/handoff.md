# Workflow — Handoff

> **何时使用**：当任务从一个 Agent / Session 转移到另一个 Agent / Session 时。
>
> 本文件是 **Agent-neutral** 的：Claude Code、Codex、Gemini CLI、Antigravity 等任何
> Coding Agent 都必须遵守它。它处理的核心问题是"如何让下一个 Agent 不依赖上一个
> Agent 的聊天上下文"。

---

## 目的

在 Claude Fleet 这种"多 Coding Agent 协作"的项目里，一个任务经常会被切给不同的
Agent、不同 Session、甚至不同人类接手。Handoff 的目标是：

> **让接手方仅靠仓库内的事实就能继续工作，不依赖任何聊天记录。**

聊天记录、模型记忆、口头描述都属于"会消失的临时状态"。它们**不是** source of truth。

---

## 何时使用

- 一个 Agent 把任务交给另一个 Agent。
- 一个 Agent Session 即将结束，需要把上下文固化到仓库。
- 长任务跨多个 Session。
- 多个 Agent 并行开发，需要清晰边界。
- Review Agent 接手 Implementation Agent 的成果。
- Debug Agent 接手其他 Agent 未解决的问题。
- 人类开发者中途接手（或交还给 Agent）。

---

## Source of Truth 优先级

```
Repository State
  +
Spec
  +
tasks.md
  +
Git Commit / Branch / PR
  +
Tests / Evidence
  +
.agent/knowledge/
```

**高于：**

```
聊天记录
模型记忆
口头描述
```

如果某个关键信息只存在于聊天记录里，而没有落到上面的任何一处，**那它就没有真的
被记录下来**。

---

## 标准交接内容（Minimum Handoff Payload）

交接至少要让下一个 Agent 知道以下七项。

### 1. Task

当前正在处理的任务：

```text
Spec:    docs/specs/<feature-slug>/
Task:    T00X <task-title>
Goal:    <一句话目标>
```

### 2. Current State

```text
Completed:
  - <已完成的子任务或里程碑>

In Progress:
  - <进行中、尚未验证完成的部分>

Not Started:
  - <尚未开始的部分>
```

### 3. Code State

```text
Branch:           <branch name>
Latest Commit:    <short hash>  <commit subject>
Modified Files:   <尚未 commit 的修改列表，或者 "none">
Uncommitted:      <yes / no；如有，说明范围>
```

### 4. Validation

```text
Tests Run:
  - <跑过的命令 / 套件>

Passed:
  - <通过的测试 / 检查>

Failed:
  - <失败的测试 / 检查>

Not Yet Tested:
  - <尚未验证的部分，必须显式列出>
```

**绝不能**写"代码应该差不多能用了"。必须显式写：

- 测试了什么；
- 没测试什么；
- 哪些假设尚未验证。

### 5. Decisions

如果在过程中做了**重要的决定**：

- 更新了哪个 Spec / Design；
- 新增或修改了哪条 ADR；
- 或明确说明"本阶段没有新决策"。

### 6. Known Issues / Risks

必须显式记录：

- 当前阻塞；
- 已知 Bug；
- 尚未验证的假设；
- 潜在 Regression；
- 不应该重复调查的问题（链接 `.agent/knowledge/pitfalls.md` 中相关条目，如果有）。

### 7. Next Action

必须给下一个 Agent 一个**明确的、可立即执行**的 Recommended Next Step。

避免：

```text
"继续完成剩下的部分。"
```

要求：

```text
"接下来按 tasks.md 的 T0XX 执行：在 src/<path> 新增 X，验证 Y，
完成后跑 `npm test` 并把结果回填到本节。"
```

---

## `tasks.md` 是进度 Source of Truth

`tasks.md` 是 Feature 实现进度的主要 Source of Truth 之一。允许记录类似：

```markdown
- [x] T001 建立 Instance 类型
  - Evidence: tests/instance.test.ts
  - Commit:  abc1234

- [ ] T002 实现 InstanceManager
  - Depends on: T001

- [ ] T003 接入 VS Code Terminal Adapter
  - Depends on: T002
```

未来如果确实存在多 Agent 并行，可以逐步扩展元数据：

```text
Owner
Status
Depends On
Evidence
Commit / PR
```

但**当前不要强制所有 Task 都写 Owner**：

> 先保持轻量，等真正发生多 Agent 并行时再增加必要元数据。

---

## 禁止的 Handoff 模式

### 只靠聊天记录

```text
"你看一下我前面的聊天就知道了。"
```

不可接受。聊天记录是临时状态，不入仓就没了。

### 没有验证状态

```text
"代码应该差不多能用了。"
```

不可接受。必须显式说明"测了什么 / 没测什么"。

### 隐藏未完成工作

不得因为换 Agent 就把 `FIXME`、`TODO`、失败的测试、`workaround`、临时假设藏起来。

交接 = 透明。下一个 Agent 看到的事实必须和你看到的事实一致。

### 未 Commit 的大规模交接

如果一个任务已经形成稳定的阶段性成果，**优先形成可追踪 Commit**，再交接。
不要让另一个 Agent 面对大量不知道来源的 uncommitted changes。

---

## Handoff 和知识系统的关系

Handoff **不是**长期知识库。不要把所有交接内容塞进：

```text
lessons.md
pitfalls.md
decisions.md
```

只有具备**长期价值**的内容才晋升到 `.agent/knowledge/`：

```text
普通进度          → tasks.md / Git Commit
架构决策          → decisions.md (ADR)
踩坑              → pitfalls.md
通用经验          → lessons.md
验证结果          → tests / CI / PR / commit evidence
```

交接时写下的"当前阻塞 / 已知 Bug / 尚未验证的假设"，如果具备复用价值，再单独
晋升；否则只留在 `tasks.md` 与当前 Spec / PR 里。

---

## 自检清单（交接前）

在宣告"交接完成"之前，发起方应自检：

- [ ] `tasks.md` 中已完成的 Task 打了勾、未完成的描述清晰。
- [ ] 当前进展已经被 commit（或明确说明 uncommitted changes 的范围）。
- [ ] 跑过的测试 / 检查结果被写进了交接内容。
- [ ] 没有只存在于聊天里的关键决策。
- [ ] 没有未记录的 `TODO` / `FIXME` / 失败测试 / workaround。
- [ ] Recommended Next Step 足够明确，接手 Agent 不需要猜测。

---

## 接手方第一动作（接收后）

接手方第一时间应该：

1. 跑一遍交接里的"Validation"步骤，确认当前仓库状态确实和交接描述一致；
2. 阅读相关 Spec / `tasks.md` / 最近 commits；
3. 验证 Recommended Next Step 是否仍然成立。

**不要**先相信交接内容再相信仓库 —— 先验证仓库，再决定是否信任交接。