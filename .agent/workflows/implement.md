# Workflow — Implement

> **何时使用**：准备为 Spec 中的某个 Task 写代码时。

---

## 目的

完成 Spec 中对应 Task 所要求的 **最小正确改动**，并留下证据证明它有效，
同时保持文档一致。

---

## 流程

```text
阅读 AGENTS.md
 ↓
阅读相关 Spec
 ↓
检查现有代码
 ↓
制定实现计划
 ↓
完成最小正确改动
 ↓
测试
 ↓
更新相关文档
 ↓
Review
```

---

## 各步骤

### 阅读 AGENTS.md

打开 `AGENTS.md`，重新阅读"必须遵守的开发流程"与"核心工程原则"。它们约束所有任务。

### 阅读相关 Spec

- 打开 `docs/specs/<feature-slug>/requirements.md`、`design.md`、`tasks.md`。
- 确认要做的 Task 已经在 `tasks.md` 中列出。
- 如果 Task 没有列出，要么补到 `tasks.md`（小范围改动），要么停下来走
  `.agent/workflows/spec-coding.md`（非平凡改动）。

### 检查现有代码

- 定位相关模块。
- 读足够多的周围代码以理解现有模式与约定。
- 沿用它们，不要为了一个文件发明新的风格。

### 制定实现计划

写代码前，明确：

- 你打算改什么。
- 为什么这是"最小正确"的版本。
- 你如何验证它能工作（测试、人工复现、日志）。
- 哪些地方可能 Regression，以及如何检查。

### 完成最小正确改动

- 只动 Task 涉及的范围。
- 不要在同一改动里顺手重构相邻代码。
- 不要"既然都来了"加一堆投机性功能。
- 注释密度、命名、风格与项目保持一致。

### 测试

- 跑现有覆盖该区域的测试，它们必须仍然通过。
- 如果改动非平凡，加一条新测试。
- 如果是 Bug 修复，加一条 Regression Test：在没有修复时它会失败。

### 更新相关文档

如果改动：

- 改变了公开行为 → 更新对应的 `docs/specs/...` 文件；
- 改变了架构 → 更新 `docs/ARCHITECTURE.md`，必要时新增 ADR（`.agent/knowledge/decisions.md`）；
- 暴露了可复用经验 / 坑 / 决策 → 记录到 `.agent/knowledge/`，并链接相关 workflow。

### Review

交给 `.agent/workflows/review.md`。

---

## 反模式

- **跳过读 Spec。** 这是"代码做错事"的最常见来源。
- **借机"小重构"。** 把它们拆成独立的 Task 写进 `tasks.md`。
- **静默扩大 Scope。** 如果发现自己做的事超过 Task 所说，停下来，先更新 `tasks.md`。
- **非平凡改动不加测试。** 没法验证的改动不算完成。