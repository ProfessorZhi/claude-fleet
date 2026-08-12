# docs/specs/ — Feature Spec 目录

本目录用于存放 Agent Fleet 的 **Feature Spec**。

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

| 文件              | 职责                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `requirements.md` | 这个 Feature 要做什么、为什么、范围与非范围                                        |
| `design.md`       | 这个 Feature 的架构 / UX 设计，包含 Component / Data / Interface / 失败模式 / 取舍 |
| `tasks.md`        | 实现这个 Feature 的具体任务列表                                                    |

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

Agent Fleet 是新文档和新 Spec 的 canonical brand。旧目录中的 Claude Fleet 名称仅表示
历史迁移或兼容上下文；本索引不再规划第二轮品牌迁移。

| Slug                                         | 状态     | 概要                                                          |
| -------------------------------------------- | -------- | ------------------------------------------------------------- |
| `001-multi-instance-runtime`                 | 已实现   | Claude Code 多实例 Runtime                                    |
| `002-provider-model-isolation`               | 已实现   | Provider / Model 隔离                                         |
| `003-instance-status`                        | 已实现   | Agent 状态与事件                                              |
| `004-minimal-control-ui`                     | 已实现   | 最小控制 UI                                                   |
| `005-provider-registry-session-continuity`   | 已实现   | Provider Registry / Session Continuity                        |
| `006-branding-discovery-migration`           | 已实现   | 品牌、迁移、Discovery upsert                                  |
| `agentmetrics-integration`                   | 进行中   | agentmetrics 合并与 Fleet identity 合同（非编号迁移基础）     |
| `007-fleet-observability-workflow`           | 进行中   | 当前 Codex Client + Claude Code Worker 拓扑与 FleetEvent      |
| `008-fleet-command-scene`                    | 已实现   | 可切换 Fleet Command / Pixel Office Scene                     |
| `009-fleet-command-control-center`           | 已实现   | Mission / Instance / Terminal / Timeline 控制中心             |
| `010-fleet-scene-visual-system`              | 部分实现 | 角色舰型、状态映射与确定性视觉 fallback；sprite/Canvas 待后续 |
| `011-fleet-command-information-architecture` | 进行中   | Scene First、Mission Rail、按需详情与紧凑观测区               |
| `012-fleet-command-localization`             | 进行中   | Fleet Command 简体中文显示层                                  |
| `013-configurable-scene-preference`          | 进行中   | 办公室默认前端、设置页切换与场景入口                          |
| `014-coordinator-management-api`             | 进行中   | Coordinator 多 Agent 生命周期与安全查询                       |
| `015-runtime-choice-new-agent`               | 进行中   | 新建 Agent 选择 Claude Code / Codex CLI 与本地登录复用        |
| `016-coordinator-workflow`                   | 进行中   | Coordinator 的 WorkItem 分配与结果回收边界                    |
| `017-delivery-closure`                       | 进行中   | Scheduler、任务投递、Telemetry、SCM 与交付验收                |
| `018-production-closure`                     | 进行中   | Coordinator Session、结果闭环、真实边界、安全恢复与发布       |

完整 MVP Spec Index 在 Phase 1 完成后由 [`docs/ROADMAP.md`](../ROADMAP.md) 引用并
在此处同步。
