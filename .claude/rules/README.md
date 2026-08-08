# .claude/rules/ — Claude Code Rules

> **仅供 Claude Code 使用。**  
> 这里的 Rules 是 Claude-Code 专属的行为约束，是叠加在共享规则
> （`AGENTS.md` 与 `.agent/`）之上的薄适配层。

**原则：**

- **不要把共享知识复制到这里。** 任何对所有 Agent 都适用的内容，都属于 `AGENTS.md`
  或 `.agent/`。
- **这里的 Rule 只放 Claude-Code 专属内容。** 合法的例子包括：
  - 本项目中 Claude Code 的权限与允许工具列表；
  - Claude-Code 专属的 Hook（例如编辑后自动格式化）；
  - Claude-Code 专属的默认值（model、fast-mode、statusline）。

**不要放在这里：**

- "怎么写 Feature Spec" —— 那是 `.agent/workflows/spec-coding.md`。
- "怎么 Debug" —— 那是 `.agent/workflows/debug.md`。
- "项目是什么" —— 那是 `docs/PROJECT.md`。
- 架构决策 —— 那些是 `.agent/knowledge/decisions.md` 中的 ADR。

保持本目录极简。如果它超过几个文件，通常意味着"共享知识泄漏到了 vendor 专属位置"，
应该把它晋升上去。