# Workflow — Review

> **何时使用**：实现完一个 Feature、修完一个 Bug、或任何"非平凡到值得在合并前检查"的
> 改动之后。

---

## 目的

在改动合并之前抓住问题：Spec 漂移、正确性缺口、Regression 风险、架构侵蚀、文档腐化，
以及"漏掉了可以复利的知识"。

没有这些视角的 Review，只是个人意见。每一项都要跑。

---

## 检查清单

每一项视角下都要问：*要变成什么样，这次改动才算错的？* 如果答不上来，就还没真正
Review 过。

### 1. 是否符合 Spec

- 改动是否做了 `docs/specs/.../requirements.md` 要求的事？
- 是否尊重了 `design.md`？如果现实偏离了设计，是否先更新了 `design.md`？
- 有没有混入 **Out of Scope** 的内容？
- 如果根本没有 Spec，是否应该有一个？（如果是，回到 `spec-coding.md`。）

### 2. 正确性

- 改动是否真的解决了声明的问题？
- 是否处理了 `design.md` 列出的失败模式？
- 是否考虑过未覆盖的输入 / 状态？边界、空输入、并发访问、大输入、畸形输入。
- 如果是 Bug Fix：是否解决了 **Root Cause**，而不是症状？（参见 `debug.md`。）

### 3. Regression 风险

- 已有功能里，哪些可能被这次改动打坏？
- 已有测试是否仍然通过？
- 是否存在专门覆盖这块区域的测试？如果没有，是否需要补？
- Bug Fix 专问：是否有一条 **Regression Test**，在没有 Fix 时会失败？

### 4. Tests

- 新行为是否有测试？
- 测试测的是不是"行为"而不是"实现细节"？
- 测试是否覆盖失败模式，还是只覆盖 happy path？
- 测试未来是否能抓到这次 Bug 的精确回归？

### 5. Architecture 影响

- 这次改动是否把系统拉向了与 `docs/ARCHITECTURE.md` 不同的方向？
- 是否写入了"应该被抽象"的 vendor 假设（例如"只支持 Claude Code"）？
- 是否建立了新边界，或越过了不该越的边界？
- 如果这次改动在架构上有意义，是否已经在 `.agent/knowledge/decisions.md` 落 ADR？

### 6. Documentation 影响

- 受影响的文档（`docs/PROJECT.md`、`docs/ARCHITECTURE.md`、`docs/ROADMAP.md`、
  对应 Spec）是否仍然准确？
- 行为变了，Spec 是否更新？
- 是否有新的架构决策需要记录？
- 代码内联注释是否仍然准确（没有过期、不过度解释）？

### 7. 不必要的复杂度

- 这次改动是否可以更小？
- 是否引入了可以被现有 API / 现有抽象替代的"自造新抽象"？
- 是否出现了"配置项先行"的反模式 —— 在还没有第二份配置之前先做一层抽象？

### 8. 是否值得沉淀的经验

- 这次改动是否暴露了 **未来 Agent 应该知道** 的经验？
- 是否暴露了 **项目应该避免** 的高风险坑？
- 是否做出了 **应该被记录为 ADR** 的架构决策？
- 是否暗示了 **可以被自动化** 的检查（→ `.agent/scripts/`）？
- 是否暗示了 **重复出现的模式**，应当形成或优化某条 workflow？

如果以上任意一项为"是"，按 `AGENTS.md` 的晋升规则记录。

---

## 反模式

- **"看起来没问题。"** 没有逐项证据的 Review 不算 Review。
- **只做风格 / Lint Review。** 风格与命名重要，但不是全部。Spec 符合度、正确性、
  Regression 风险、架构影响更重要。
- **Bug Fix 跳过 Regression Test 检查。** 没有 Regression Test 的 Bug Fix 是
  一个注定会回来的 Bug。
- **Review 中悄悄扩大 Scope。** 如果 Review 揭示了新的工作，把它作为对应 Spec 的
  跟进 Task 单独列，不要静默塞进当前改动。

---

## 输出

Review 完成的条件：以上每一项视角都已被显式考虑，并在 PR 描述、commit message 或
Review 笔记中留下结论（或显式写"无问题"）。模糊的 Approve 不是 Review。