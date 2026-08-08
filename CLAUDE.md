# CLAUDE.md — Claude Code 适配层

> **本文件只针对 Claude Code。**
> 所有项目级规则与共享知识都在 `AGENTS.md` 和 `.agent/`。
> 本文件只是把 Claude Code 指向它们的薄适配层。

---

## 首先阅读

在开始任何任务之前，Claude Code 必须阅读并遵守：

- `@AGENTS.md` —— 本项目所有 Coding Agent 的统一入口。

`AGENTS.md` 是权威。如果这里的内容与 `AGENTS.md` 冲突，**以 `AGENTS.md` 为准**。

---

## 资料位置

| 内容 | 位置 |
|---|---|
| 共享规则、原则、导航 | `AGENTS.md` |
| 项目信息（背景、架构、Roadmap、Spec） | `docs/` |
| 共享工作流（spec / implement / debug / review） | `.agent/workflows/` |
| 经验、坑、架构决策 | `.agent/knowledge/` |
| 外部参考资料、模板、确定性脚本 | `.agent/references/`、`.agent/templates/`、`.agent/scripts/` |
| Claude Code 专属能力 | `.claude/skills/`、`.claude/rules/` |

---

## 适配层规则

- **不要在 `.claude/` 里复制共享知识。** 如果一条规则对所有 Agent 都适用，就放在
  `AGENTS.md` 或 `.agent/`，而不是这里。
- **写代码前先遵守 `AGENTS.md` 中的流程：** 理解 → Spec → Plan → Implement → Validate → Review → Learn。
- **保持 `.claude/skills/` 和 `.claude/rules/` 简洁。** 它们描述的是 Claude Code 专属行为
  （slash command、hook、权限），不是项目领域知识。

---

## 关于本阶段

- Claude Code 是当前阶段（Phase 0 / Phase 1）的主要开发 Agent。
- 公共规则以 `AGENTS.md` 为准，Claude Code 不得绕过它去"自行决定"。
- 等公共 Workflow 稳定之后，再决定哪些能力需要 Claude-specific Adapter。