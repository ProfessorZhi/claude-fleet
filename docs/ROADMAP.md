# ROADMAP.md — Claude Fleet

> 阶段式推进计划。不写具体日期 —— 阶段推进的条件是"上一个阶段的 Exit Criteria 达成"，
> 而不是日历上的某个点。  
> 产品说明见 [`PROJECT.md`](./PROJECT.md)；架构理解见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## Phase 0 — 项目基础设施

**目标**：为后续所有阶段打好基础。

- 项目级文档系统（`AGENTS.md` / `docs/` / `.agent/` / `.claude/`）。
- 公共 Agent 工作流（spec-coding / implement / debug / review）。
- 知识沉淀与晋升机制（lessons / pitfalls / decisions / workflows / scripts）。
- 项目愿景、架构草案、Roadmap 本体。

**Exit Criteria**：

- 文档层存在、内容自洽，并已被至少一个 Agent 完整阅读且未发现冲突。

---

## Phase 1 — MVP Spec

**目标**：锁定第一个可用产品的最小范围。

- 在 `docs/specs/` 下创建 MVP 的 Feature Spec（`requirements.md` / `design.md` / `tasks.md`）。
- 回答 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 中所有 MVP 范围内的 Open Question。
- 重要决策以 ADR 形式落到 `.agent/knowledge/decisions.md`。
- MVP 要"小到能造出来，但真到能验证多实例与隔离"。

**Exit Criteria**：

- `docs/specs/mvp/` 存在并完整；
- MVP 范围内的架构问题要么已答、要么显式 defer 且注明理由。

---

## Phase 2 — Claude Code 多实例

**目标**：在同一 VS Code Extension 内同时运行多个 Claude Code 实例，每个实例独立
绑定 Repo / Provider / Model / Session。

- 启动、监控、停止多个 Claude Code Session。
- 每个实例独立的配置 UI。
- 每个实例独立的 Repo 绑定。
- 实时状态展示（先文字版，可视化下一阶段）。

**Exit Criteria**：

- 能在 Extension 内并发跑 ≥2 个 Claude Code 实例，且状态、环境、配置互不污染。

---

## Phase 3 — Provider / Model 隔离

**目标**：把 Provider 与 Model 提到一等公民，支持按实例切换。

- 可插拔 Provider 抽象（当前阶段至少覆盖 Anthropic；其他 Provider 作为扩展点）。
- 每个实例独立选择 Model。
- 环境隔离被显式验证、可测试。

---

## Phase 4 — 状态监控与可视化

**目标**：Pixel-style 实时展示所有 Agent 的状态。

- Agent 以房间 / sprite 形式呈现在虚拟工作区中。
- 实时更新挂在前几个阶段的 Status / Event Stream 上。
- 交互：点击 Agent 聚焦、查看 transcript / 动作。

---

## Phase 5 — 多 Coding Agent 扩展

**目标**：让 Claude Fleet 走出"只支持 Claude Code"。

- Codex、Gemini CLI、Antigravity 等作为一等实例。
- 统一的 Instance Model，新增 Coding Agent 不需要重写宿主或可视化层。
- 仅在出现清晰用户需求时才引入跨 Agent 协作流程。