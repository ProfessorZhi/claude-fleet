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

## Phase 1 — MVP Spec Set

**目标**：确定第一版 MVP 由**哪些 Feature Spec** 组成，并为每个 Feature 完成
`requirements.md` / `design.md` / `tasks.md`。

MVP **不是**一个巨型 Spec，而是**多个独立 Feature Spec 的集合（Spec Set）**。
这样可以：

- 让多个 Agent 并行实现不同 Feature；
- 避免单个 Spec 里的 Tasks 膨胀；
- 避免 Design 把多个边界混在一起。

Phase 1 首先要产出 **MVP Spec Index**，列出 MVP 包含哪些 Feature Spec，并明确
它们之间的依赖关系。

MVP Spec Index 示例（仅示例，最终列表由 Phase 1 决定）：

```text
MVP
├── 001-multi-instance-runtime
├── 002-provider-model-isolation
├── 003-instance-status
└── 004-minimal-control-ui
```

> ⚠️ 上面的列表只是示例。**不要把示例当成已经批准的最终 MVP**。
> Feature 数量、命名、边界都可能调整。

具体 Feature Spec 的写法遵循 `.agent/workflows/spec-coding.md` 和
[`docs/specs/README.md`](./specs/README.md)。

**Exit Criteria**：

- MVP Feature List 已确定（即 MVP Spec Index）。
- 每个 Feature 都有独立 Spec（独立的 `docs/specs/<slug>/`）。
- Feature 之间的依赖关系明确（谁依赖谁、依赖什么）。
- MVP 范围的关键架构问题要么已答、要么显式 defer 并注明理由。
- 重要架构决策以 ADR 形式落到 `.agent/knowledge/decisions.md`。

---

## Phase 2 — Claude Code 多实例 Runtime

**目标**：在同一 VS Code Extension 内建立**可靠的 Claude Code 多实例 Runtime**。

主要内容：

- 同时启动多个 Claude Code 实例。
- 停止 / 重启 / 跟踪实例生命周期。
- 每个实例绑定独立 Repo。
- 每个实例拥有独立 Session。
- Instance Manager。
- 基础生命周期状态（最少覆盖）：
  - `starting`
  - `running`
  - `waiting`
  - `idle`
  - `stopped`
  - `error`
- 最基础的文字状态 UI（不要求可视化）。

**本阶段重点验证：**

> 多个 Claude Code 实例可以同时稳定运行。

**本阶段**不**要求：**

- 完成完整 Provider / Model 隔离系统（这是 Phase 3 的事）。
- 所有实例必须配置不同 Provider / Model。MVP Runtime 初期可以全部使用同一种
  Provider，但必须保证 **Repo / Session 不互相污染**。

**Exit Criteria**（至少）：

- Extension 内可以并行运行 ≥2 个 Claude Code 实例。
- 两个实例的 Repo / Session 不互相污染。
- 能分别启动、观察、停止每个实例。
- 能识别并展示基础生命周期状态（`starting` / `running` / `waiting` / `idle` /
  `stopped` / `error`）。

---

## Phase 3 — Provider / Model 独立配置与隔离

**目标**：让 Provider / Model 成为 Instance 的一等配置，并保证实例之间互不污染。

主要内容：

- 每实例独立 Provider。
- 每实例独立 Model。
- Provider Profile。
- Model Profile。
- 独立配置环境。
- `CLAUDE_CONFIG_DIR` / 环境变量等隔离策略（具体策略由对应 Spec 决定，本文件不预设）。
- Provider 切换。
- Model 切换。
- 隔离测试。
- Regression Tests。

**核心 Exit Criteria**（示例）：

```text
Instance A → MiniMax
Instance B → Anthropic
```

- 修改 A 的 Provider / Model **不得**影响 B。
- A 与 B 的环境（配置目录、env 等）互不污染。

**Phase 3 才正式完成 Provider / Model Isolation**。Phase 2 提供的隔离能力只是
Runtime / Repo / Session 级别的。

**当前状态（2026-08-08）**：Spec 002（[`docs/specs/002-provider-model-isolation/`](./specs/002-provider-model-isolation/)）
实现完成。核心 Exit Criteria 中"修改 A 不得影响 B"已通过单测验证（`server/__tests__/launchConfig.test.ts`）；
运行时手动验证（同一 VS Code 内同时跑两个不同 Provider 实例）需要 GUI 环境，
属于"人类用户在 VS Code 中执行的最终确认"，留待实际部署时执行。
`CLAUDE_CONFIG_DIR` 隔离方案由 [ADR-002](./specs/002-provider-model-isolation/design.md#adr-002-%E6%91%98%E8%A6%81)
锁定为方案 A（per-terminal env + `claude --model`，**不**强制独立 config dir）。

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

---

## v0.1 Alpha — 当前版本状态（2026-08-08）

```text
001 multi-instance-runtime                   ✅
002 provider-model-isolation                 ✅
003 instance-status                          ✅ Alpha scope
004 minimal-control-ui                       ✅ Alpha scope
005 provider-registry-session-continuity     ✅（Provider Registry / Restart=Resume /
                                                Switch Provider / CLI providers+launch）
006 branding-discovery-migration             ✅（PixelAgents→ClaudeFleet 品牌 /
                                                ~/.claude-fleet 迁移 / Discovery upsert /
                                                Branding assets）

v0.1 Alpha
状态：Implementation Complete / Awaiting Extension Development Host Manual Test
（不是 Released — 等待用户手动 Development Host 测试；VSIX Packaging BLOCKED）
```

- 详细状态见 [`ALPHA_RELEASE.md`](./ALPHA_RELEASE.md)。
- Development Host 手动测试清单见 [`MANUAL_TEST_ALPHA.md`](./MANUAL_TEST_ALPHA.md) 阶段一。
- Development Host 测试通过后：`npm run vsix` → VSIX 安装测试 → tag
  `v0.1.0-alpha.N` → GitHub Pre-release → 上传 VSIX → （后续）Marketplace。
- 仅在出现清晰用户需求时才引入跨 Agent 协作流程。
