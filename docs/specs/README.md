# docs/specs/ — Feature Spec 目录

本目录用于存放 Claude Fleet 的 **Feature Spec**。

每个非平凡功能都应该有独立目录，遵循 `.agent/workflows/spec-coding.md` 中的流程：

```text
docs/specs/
└── <feature-slug>/
    ├── requirements.md   # 功能要做什么、为什么
    ├── design.md         # 架构 / UX 层的设计
    └── tasks.md          # 实现该功能的具体任务列表
```

---

## 核心约定

### 一个 Feature 一个 Spec

> **禁止把多个 Feature 塞进同一个 Spec 目录。**

`mvp/` 这种"把所有 MVP 功能打包成一个 Spec"的写法被**显式禁止**。原因：

- 巨型 Spec 难以让多个 Agent 并行实现；
- Tasks 容易膨胀、互相纠缠；
- Design 容易把多个边界混在一起，后续重构成本极高；
- Review 时很难定位问题属于哪个 Feature。

### MVP / Release / Milestone = Spec Set

MVP、Release、Milestone 都是**由多个独立 Feature Spec 组成的 Spec Set**，而不是
一个巨型 Spec。

```text
MVP Spec Set
├── 001-multi-instance-runtime
├── 002-provider-model-isolation
├── 003-instance-status
└── 004-minimal-control-ui
```

> 上面的列表只是**示例**。实际 MVP Spec Set 由 Phase 1 决定。

---

## 目录命名

- **kebab-case**，简洁、表达意图。
- **建议**使用编号前缀保持执行顺序清晰，例如 `001-multi-instance-runtime`、
  `002-provider-model-isolation`。编号**不是强制的架构要求**，但是当 Spec Set
  里 Feature 之间有依赖顺序时，编号能减少歧义。
- 命名示例：
  - `001-multi-instance-runtime`
  - `002-provider-model-isolation`
  - `003-instance-status`
  - `004-minimal-control-ui`
  - `005-pixel-visualization`
  - `006-multi-coding-agent-adapter`

---

## 文件职责

每个 Feature Spec 仍然保持三个文件：

| 文件 | 职责 |
|---|---|
| `requirements.md` | 这个 Feature 要做什么、为什么、范围与非范围 |
| `design.md` | 这个 Feature 的架构 / UX 设计，包含 Component / Data / Interface / 失败模式 / 取舍 |
| `tasks.md` | 实现这个 Feature 的具体任务列表 |

---

## 活文档与 Spec Set 一致性

- **Spec 先于代码。** 在 `requirements.md` 与 `design.md` 存在之前，不得开始实现
  （参见 `AGENTS.md` → 必须遵守的开发流程）。
- **Spec 是活文档。** 设计在 build 过程中演化时，先更新 `design.md`，再让代码跟上。
  任务认知有偏差时，先更新 `tasks.md`。不要让 Spec 偷偷过期。
- **Spec Set 索引要保持同步。** 增加 / 移除 / 重排 Feature 时，更新 `docs/ROADMAP.md`
  中对应的 MVP / Release / Milestone 列表。
- **ADR 互相引用。** 如果某个 Spec 引入或依赖了一项架构决策，在该 Spec 的 `design.md`
  中链接到 `.agent/knowledge/decisions.md` 中的对应 ADR。

---

## 文件正文语言

- 正文默认使用 **简体中文**。
- 技术名词、代码、API、CLI 命令保持英文。

---

## 当前 Spec 索引

| Slug | 状态 | 概要 |
|---|---|---|
| *(暂无)* | — | Spec 将在 Phase 1（MVP Spec Set）阶段陆续创建。 |

完整 MVP Spec Index 在 Phase 1 完成后由 [`docs/ROADMAP.md`](../ROADMAP.md) 引用并
在此处同步。