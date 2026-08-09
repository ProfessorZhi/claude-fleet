# `.agent/` — Agent-neutral 工作层

这里放所有 Coding Agent 都能使用的公共工作流、知识、参考、模板和确定性脚本。

```text
.agent/
├── workflows/    任务流程：spec、implement、debug、review、handoff、协作
├── knowledge/    lessons、pitfalls、ADR
├── references/   外部项目与协议参考
├── templates/    Spec、handoff、review 等模板
└── scripts/      可重复执行的确定性辅助脚本
```

规则：

- 对所有 Agent 通用的内容放这里，不放到 `.claude/` 或 `.codex/`。
- 这里描述“怎么工作”，产品架构和功能放 `docs/`。
- 跨 Agent / 跨 Session 交接必须写入 Spec、tasks、Git 和本目录知识，不依赖聊天。
- Vendor-specific 的行为只放在 `CLAUDE.md`、`.claude/`、`CODEX.md` 或 `.codex/`。
