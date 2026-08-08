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

## 命名与组织约定

- **一个 Feature 一个目录。** 禁止把多个 Feature 塞进同一个 Spec。
- **目录命名**：kebab-case，简洁、表达意图。例如 `mvp`、`multi-instance-runtime`、
  `provider-isolation`、`pixel-visualization` 等。
- **Spec 先于代码。** 在 `requirements.md` 与 `design.md` 存在之前，不得开始实现
  （参见 `AGENTS.md` → 必须遵守的开发流程）。
- **Spec 是活文档。** 设计在 build 过程中演化时，先更新 `design.md`，再让代码跟上。
  任务认知有偏差时，先更新 `tasks.md`。不要让 Spec 偷偷过期。
- **ADR 互相引用。** 如果某个 Spec 引入或依赖了一项架构决策，在该 Spec 的 `design.md`
  中链接到 `.agent/knowledge/decisions.md` 中的对应 ADR。

## 文件正文语言

- 正文默认使用 **简体中文**。
- 技术名词、代码、API、CLI 命令保持英文。

## 当前 Spec 索引

| Slug | 状态 | 概要 |
|---|---|---|
| *(暂无)* | — | Spec 将在 Phase 1（MVP Spec）阶段陆续创建。 |