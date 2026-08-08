# Claude Fleet

**Claude Fleet** 是一个面向 VS Code 的多 Coding Agent 管理工具。

> **当前状态：早期开发 / 文档与架构设计阶段。**
> 目前还没有可安装的插件，也没有任何业务代码。本仓库当前仅包含项目级
> 文档系统、Agent 工作流骨架与知识沉淀机制。

---

## 项目方向

第一阶段重点：管理多个 **Claude Code** 实例。

具体方向：

- 多 Claude Code 实例同时运行
- 每个实例绑定独立 Repo
- 每个实例独立 Provider
- 每个实例独立 Model
- 每个实例独立 Session 与配置环境
- 实时展示每个 Agent 的运行状态与工作进度
- Pixel-style 可视化

后续阶段会扩展到更多 Coding Agent：

- Claude Code（当前阶段）
- Codex
- Gemini CLI
- Antigravity
- 其他 Coding Agent

---

## 项目级 Agent 工作体系

本仓库不是一个普通的应用代码仓库。它的首要资产是 **项目级文档 + Agent 工作流**：

```text
AGENTS.md      所有 Coding Agent 的统一入口（Agent-neutral）
docs/          项目是什么、要做什么（背景、架构、Roadmap、Spec）
.agent/        Agent 应该怎么工作（工作流、经验、参考、模板、脚本）
.claude/       Claude Code 的薄适配层（skills / rules）
```

要点：

- `AGENTS.md` + `docs/` + `.agent/` 是 **Agent-neutral** 公共知识层，不得只写进 `.claude/`。
- 项目经验通过 `.agent/knowledge/` 沉淀，而不是堆到 `AGENTS.md`。
- 流程：**理解 → Spec → Plan → Implement → Validate → Review → Learn**。

更详细的说明见 [`AGENTS.md`](./AGENTS.md)。

---

## 当前仓库里 *没有* 的东西

为了避免误导读者：

- ❌ 暂无 VS Code 插件安装包
- ❌ 暂无 `npm install` 步骤
- ❌ 暂无 Provider / Model / Session Manager 的实现
- ❌ 暂无 UI / 可视化
- ❌ 暂无正式 Feature Spec（`docs/specs/` 目录目前只有 README）

这些都将在后续 Phase 中，按 [`docs/ROADMAP.md`](./docs/ROADMAP.md) 推进。

---

## 仓库结构

```text
.
├── README.md
├── AGENTS.md
├── CLAUDE.md
├── .gitignore
│
├── docs/
│   ├── PROJECT.md
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── specs/
│       └── README.md
│
├── .agent/
│   ├── workflows/        # spec-coding / implement / debug / review
│   ├── knowledge/        # lessons / pitfalls / decisions
│   ├── references/
│   ├── templates/
│   └── scripts/
│
└── .claude/
    ├── skills/
    └── rules/
```

---

## 许可证

待定（TBD）。