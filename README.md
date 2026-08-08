# Claude Fleet

**Claude Fleet** 是一个面向 VS Code 的多 Coding Agent 管理工具。

> **当前状态：早期开发。**  
> 第一阶段基于上游 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
> 的 VS Code Extension、多 Claude Code Terminal、状态检测与 Pixel UI 能力进行
> 二次开发，使 Claude Fleet 能够同时创建、识别、展示多个独立 Claude Code Session。

---

## 项目方向

第一阶段重点：管理多个 **Claude Code** 实例。

具体方向：

- 多 Claude Code 实例同时运行
- 每个实例绑定独立 Repo
- 每个实例独立 Provider（Phase 3）
- 每个实例独立 Model（Phase 3）
- 每个实例独立 Session 与配置环境
- 实时展示每个 Agent 的运行状态与工作进度
- Pixel-style 可视化（直接复用上游）

后续阶段会扩展到更多 Coding Agent：

- Claude Code（当前阶段）
- Codex
- Gemini CLI
- Antigravity
- 其他 Coding Agent

完整规划见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

---

## 项目级 Agent 工作体系

本仓库的首要资产是 **项目级文档 + Agent 工作流 + 二次开发的代码基线**：

```text
AGENTS.md      所有 Coding Agent 的统一入口（Agent-neutral）
docs/          项目是什么、要做什么（背景、架构、Roadmap、Spec）
.agent/        Agent 应该怎么工作（工作流、经验、参考、模板、脚本）
.claude/       Claude Code 的薄适配层（skills / rules）
adapters/      VS Code Extension 入口（基于 Pixel Agents）
server/        Agent 运行时（Hook / AgentState / Persistence）
core/          Provider 接口 / Adapter / Message / Asset Loader
webview-ui/    Pixel Canvas + 组件
```

完整阅读顺序见 [`AGENTS.md`](./AGENTS.md)。

---

## 代码来源 / Attribution

Claude Fleet 第一阶段基于 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
进行二次开发。

- 上游 Repository：https://github.com/pixel-agents-hq/pixel-agents
- 上游 Commit（baseline）：`9794e075d3cf1a1407766a93d3cac87813393705`
- 上游 Version：`1.4.0`
- 上游 License：**MIT** — Copyright (c) 2026 Pablo De Lucca

详细引用信息见 [`.agent/references/pixel-agents.md`](./.agent/references/pixel-agents.md)
以及 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

---

## 当前仓库里 *没有* 的东西

为了避免误导读者：

- ❌ 暂无 Provider / Model 隔离实现（属 ROADMAP Phase 3 / Spec 002）
- ❌ 暂无 Codex / Gemini CLI / Antigravity 接入（属 Phase 5）
- ❌ Marketplace 发布（Claude Fleet 暂未发布到任何市场）
- ❌ 控制面板 / Control Center UI 重构（保留上游 Pixel UI）
- ❌ 持久化、配置同步、跨 Agent 编排

这些都将在后续 Spec 中，按 [`docs/ROADMAP.md`](./docs/ROADMAP.md) 推进。

---

## 仓库结构

```text
.
├── README.md
├── AGENTS.md
├── CLAUDE.md
├── LICENSE                      # 上游 MIT（原文保留）
├── THIRD_PARTY_NOTICES.md       # 二次开发声明
├── .gitignore
│
├── docs/                        # Claude Fleet 项目信息（Spec / Roadmap / Architecture）
│   ├── PROJECT.md
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── specs/
│       ├── README.md
│       └── 001-multi-instance-runtime/
│
├── .agent/                      # Agent 工作流与知识
│   ├── workflows/
│   ├── knowledge/
│   ├── references/
│   ├── templates/
│   └── scripts/
│
├── .claude/                     # Claude Code 适配层
│   ├── skills/
│   └── rules/
│
├── adapters/vscode/             # VS Code Extension 入口（上游）
├── server/                      # Agent 运行时（上游）
├── core/                        # Provider / Adapter 接口（上游）
├── webview-ui/                  # Pixel Canvas（上游）
├── scripts/                     # 构建 / 工具脚本（上游）
├── e2e/                         # E2E 测试（上游）
└── ...（其他构建 / 配置文件，上游）
```

---

## 开发与构建

按上游 `package.json` 脚本（直接可用）：

```bash
npm install
npm run check-types
npm run build
npm test
npm run lint
```

详细工作流见 [`.agent/workflows/`](./.agent/workflows/)。

---

## 许可证

- 上游代码：**MIT**（保留 `LICENSE` 文件原文）。
- Claude Fleet 新增的代码：与上游相同按 MIT 发布（详见 `LICENSE`）。
- 二次开发关系说明：[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。