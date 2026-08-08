# .claude/skills/ — Claude Code Skills

> **仅供 Claude Code 使用。**  
> Skills 是 Claude Code 专属的能力（slash command、task 类型、agent 定义）。本目录是
> 位于共享知识 `AGENTS.md` 与 `.agent/` 之上的**薄适配层**。

**原则：**

- **不要把项目知识复制到这里。** 如果一条指引对所有 Agent 都适用，就放在 `AGENTS.md`
  或 `.agent/`，而不是这里。
- **Skills 是能力，不是文档。** 一个 Skill 应该赋予 Claude Code 一个具体可做的事
  （slash command、有引导的任务），而不是复述项目规则。
- **Skill 可以引用共享工作流。** 一个 Skill 可以指向 `.agent/workflows/*.md` 来获得
  实际流程，而不必自己重新写一遍。

**什么时候加一个 Skill：**

- Claude Code 需要一个 Claude-Code 专属的能力（自定义 slash command、hook、
  MCP 驱动的能力），且不能泛化到其他 Agent。
- 出现了一个反复出现的 Claude-Code 交互模式值得打包。

**什么时候**不**应该加 Skill：**

- 行为对所有 Coding Agent 都通用 —— 放到 `.agent/workflows/`。
- 只是文档 —— 放到 `docs/` 或 `.agent/knowledge/`。

本目录中的文件应该自包含，并按它提供的能力命名（例如 `commit.md`、`open-spec.md`）。
保持数量精简。