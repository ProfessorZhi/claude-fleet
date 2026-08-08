# Workflow — Debug

> **何时使用**：东西坏了、行为不对、或出现意外结果。**改任何代码之前**，先走这个流程。

---

## 目的

终结"猜 → 改 → 重测 → 再猜"的循环。Debug 必须产出 **Root Cause**、**Fix**、
**Regression Test**，以及（在合适的时候）一条 **可复用经验**。

如果说不清 *为什么* 坏的，就不算修好。

---

## 流程

```text
复现
 ↓
收集证据
 ↓
定位 Root Cause
 ↓
修复
 ↓
Regression Test
 ↓
沉淀经验
```

不要跳过任何步骤。在 Root Cause 是"一个可被反驳的判断"之前，不要进入"修复"。

---

## 各步骤

### 1. 复现

- 在最小可能场景下，按需触发失败。
- 如果不能复现，就无法验证任何 Fix。
- 记录触发它的精确输入、环境与顺序。

### 2. 收集证据

动手猜之前，先收集：

- 日志（失败路径，带时间戳、能关联就尽量带 ID）。
- Stack Trace、错误码、原始错误信息。
- 失败前一刻相关数据的状态。
- 近期动过这块区域的提交（`git log`、`git blame`、近期 diff）。
- 任何"如果当前假设为真就会被看到"的现象。

非平凡 Bug，建议把收集到的东西写下来。未来的你（以及未来的 Agent）会感谢你。

### 3. 定位 Root Cause

写出一条**可被反驳的假设**，说明 *为什么* 失败发生。

- 假设必须能解释所有观察到的证据。
- 假设必须能预测"如果改某个具体的东西，会看到什么"。
- 如果假设不可被检验，那它还不是假设，只是猜测。回到第 2 步或重新框定问题。

这一步有用的问题：*"要怎样，这个 Bug 才不会存在？"* 从结果倒推，往往能直接命中 Root Cause。

### 4. 修复

- 改**最小**且能解决 **Root Cause** 的东西，而不是解决症状。
- 如果你写出来的是"绕过症状的 workaround"，停下来 —— 你还没找到 Root Cause，回到第 3 步。
- 风格、命名、模式与项目现有约定保持一致。

### 5. Regression Test

- 加一条测试：在没有 Fix 时它会失败，有 Fix 时它通过。
- 测试必须覆盖**同一段**坏掉的代码路径，而不是相邻的表面。
- 如果 Regression Test 真的不可行，**显式**说明原因（PR / commit message 中），
  并给出最接近的替代（snapshot、人工复现脚本等）。

### 6. 沉淀经验

如果本次 Debug 暴露了"未来 Agent 也应该知道"的东西，按 `AGENTS.md` 中的晋升规则
把它沉淀到 `.agent/knowledge/`：

| 学到什么 | 放哪里 |
|---|---|
| 通用可复用经验 | `.agent/knowledge/lessons.md` |
| 高风险坑 | `.agent/knowledge/pitfalls.md` |
| 重要架构决策 | `.agent/knowledge/decisions.md`（ADR） |
| 重复出现的处理方式 | `.agent/workflows/`（优化现有 workflow） |
| 可以自动化的检查 | `.agent/scripts/`（或 tests / CI） |
| 每次任务都必须遵守的规则 | `AGENTS.md`（晋升之后） |

不是每个 Bug 都要变成 Lesson。**主动**晋升，而不是**反射**晋升。

---

## 显式禁止

- **不要随机改代码"看看会不会好"。** 任何修改都必须挂在第 3 步的假设上。
- **不要用 workaround 遮住 Root Cause。** Workaround 只能作为临时止血，必须配一条
  跟进任务去解决 Root Cause。
- **不要反复重新调查同一个坑。** 如果又一次进入本流程处理同一 Bug，必须引用上次
  之后的变化与新证据。否则就是在空转 —— 把"空转本身"记录成一条 Lesson。
- **不要用文档代替 Regression Test。** Regression Test 的优先级永远高于"我们在文档里
  提醒一下"。

---

## 移交

Bug 修完、经验沉淀完成后：

- 跑 `.agent/workflows/review.md` Review 这个 Fix；
- 确认 Regression Test 在没有 Fix 时确实会失败、在有 Fix 时确实通过；
- 确认相关 Spec / 文档仍然与现实一致。